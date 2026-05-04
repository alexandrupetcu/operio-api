import { Worker, Queue } from "bullmq";
import { PrismaClient } from "@prisma/client";
import { redisConnection } from "../config/redis.js";
import { uploadFile } from "../lib/s3.js";
import {
  refreshAccessTokenIfNeeded,
  fetchUnreadPdfEmails,
  markAsRead,
  type IncomingEmail,
} from "../lib/gmail.js";
import { parseRevisionPdf } from "../modules/equipment-revisions/revision-pdf-parser.js";
import {
  matchClient,
  matchOrCreateEquipment,
} from "../modules/equipment-revisions/revision-matching.js";

const prisma = new PrismaClient();
const documentQueue = new Queue("document-generation", { connection: redisConnection });

const POLL_INTERVAL_MS = parseInt(process.env.GMAIL_POLL_INTERVAL_MS ?? "1200000"); // 20 min

async function processJob() {
  console.log("[email-ingestion] Polling for new emails...");

  // Load all active inboxes
  const inboxes = await prisma.emailInbox.findMany({
    where: { isActive: true, refreshToken: { not: null } },
  });

  if (inboxes.length === 0) {
    console.log("[email-ingestion] No active inboxes configured, skipping.");
    return;
  }

  // Load tenants with ingestion enabled (for global inboxes)
  const enabledTenants = await prisma.tenant.findMany({
    where: { emailIngestionEnabled: true },
    select: { id: true },
  });
  const enabledTenantIds = new Set(enabledTenants.map((t) => t.id));

  // Tenant IDs that have their own inbox
  const tenantOwnInboxIds = new Set(
    inboxes.filter((i) => i.tenantId).map((i) => i.tenantId!)
  );

  for (const inbox of inboxes) {
    let inboxError: string | null = null;

    try {
      // Determine which tenants this inbox serves
      let tenantIds: string[];
      if (inbox.tenantId) {
        tenantIds = [inbox.tenantId];
      } else {
        tenantIds = [...enabledTenantIds].filter((id) => !tenantOwnInboxIds.has(id));
      }

      if (tenantIds.length === 0) {
        console.log(`[email-ingestion] Inbox ${inbox.label}: no eligible tenants, skipping.`);
      } else {
        // Refresh token if needed
        const refreshedInbox = await refreshAccessTokenIfNeeded(prisma, inbox);

        // Fetch unread emails with PDF attachments
        const emails = await fetchUnreadPdfEmails(refreshedInbox);
        console.log(`[email-ingestion] Inbox ${inbox.label}: found ${emails.length} unread emails with PDFs.`);

        const emailErrors: string[] = [];

        for (const email of emails) {
          for (const tenantId of tenantIds) {
            try {
              await processEmail(tenantId, email, inbox.id);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              emailErrors.push(`${email.messageId}: ${msg}`);
              console.error(
                `[email-ingestion] Failed to process email ${email.messageId} for tenant ${tenantId}:`,
                err
              );
            }
          }

          try {
            await markAsRead(refreshedInbox, email.messageId);
          } catch (err) {
            console.error(`[email-ingestion] Failed to mark email ${email.messageId} as read:`, err);
          }
        }

        if (emailErrors.length > 0) {
          inboxError = emailErrors.slice(0, 3).join(" | ");
        }
      }
    } catch (err) {
      inboxError = err instanceof Error ? err.message : String(err);
      console.error(`[email-ingestion] Error processing inbox ${inbox.label}:`, err);
    } finally {
      // Always update lastPolledAt; set/clear lastError
      try {
        await prisma.emailInbox.update({
          where: { id: inbox.id },
          data: {
            lastPolledAt: new Date(),
            lastError: inboxError,
            lastErrorAt: inboxError ? new Date() : null,
          },
        });
      } catch (err) {
        console.error(`[email-ingestion] Failed to update lastPolledAt for ${inbox.label}:`, err);
      }
    }
  }

  console.log("[email-ingestion] Poll complete.");
}

async function processEmail(tenantId: string, email: IncomingEmail, inboxId: string) {
  for (const attachment of email.attachments) {
    if (!attachment.filename.toLowerCase().endsWith(".pdf")) continue;

    // Create log entry
    const log = await prisma.emailIngestLog.create({
      data: {
        tenantId,
        inboxId,
        emailMessageId: email.messageId,
        emailFrom: email.from,
        emailSubject: email.subject,
        emailDate: email.date,
        fileName: attachment.filename,
        status: "processing",
      },
    });

    try {
      console.log(`[email-ingestion] Processing: ${attachment.filename} (log: ${log.id})`);

      // Primary dedup: same Gmail messageId on revision
      const existingByMessage = await prisma.equipmentRevision.findFirst({
        where: { sourceEmailId: email.messageId },
      });
      if (existingByMessage) {
        await prisma.emailIngestLog.update({
          where: { id: log.id },
          data: { status: "completed", matchedRevisionId: existingByMessage.id, resolvedNotes: "Duplicate (messageId)" },
        });
        console.log(`[email-ingestion] Already processed messageId ${email.messageId}, skipping.`);
        continue;
      }

      // Upload PDF to S3 FIRST (so we never lose it)
      const s3Key = `${tenantId}/email-pdfs/${Date.now()}-${attachment.filename}`;
      await uploadFile(s3Key, attachment.content, "application/pdf");
      await prisma.emailIngestLog.update({ where: { id: log.id }, data: { s3Key } });

      // Parse PDF
      let parsed;
      try {
        parsed = await parseRevisionPdf(attachment.content);
      } catch (err) {
        await prisma.emailIngestLog.update({
          where: { id: log.id },
          data: { status: "failed", errorStep: "parse", errorMessage: err instanceof Error ? err.message : String(err) },
        });
        console.error(`[email-ingestion] PDF parse failed for ${attachment.filename}:`, err);
        continue;
      }

      // Store parsed data on log
      await prisma.emailIngestLog.update({
        where: { id: log.id },
        data: {
          parsedClientName: parsed.clientName,
          parsedClientSurname: parsed.clientSurname,
          parsedClientPhone: parsed.clientPhone,
          parsedClientEmail: parsed.clientEmail,
          parsedEquipmentName: parsed.equipmentName,
          parsedEquipmentSerial: parsed.equipmentSerial,
          parsedData: parsed.analysisData as any,
        },
      });

      // Match client by phone or email ONLY
      const client = await matchClient(prisma, tenantId, parsed);

      if (!client) {
        // Cannot identify client → needs_review
        await prisma.emailIngestLog.update({
          where: { id: log.id },
          data: { status: "needs_review", errorStep: "client_match", errorMessage: `Nu s-a găsit client cu phone=${parsed.clientPhone} sau email=${parsed.clientEmail}` },
        });
        console.log(`[email-ingestion] Client not found → needs_review (log: ${log.id})`);
        continue;
      }

      // Client found — continue with equipment matching (always resolves)
      const equipment = await matchOrCreateEquipment(prisma, client.id, {
        equipmentName: parsed.equipmentName ?? undefined,
        equipmentSerial: parsed.equipmentSerial ?? undefined,
        fuel: (parsed.analysisData as Record<string, string>)?.combustibil ?? undefined,
      });

      // Secondary dedup
      if (parsed.revisionDate && parsed.analyzer.serial) {
        const existingByContent = await prisma.equipmentRevision.findFirst({
          where: { equipmentId: equipment.id, revisionDate: parsed.revisionDate, analyzerSerial: parsed.analyzer.serial },
        });
        if (existingByContent) {
          await prisma.emailIngestLog.update({
            where: { id: log.id },
            data: { status: "completed", matchedClientId: client.id, matchedEquipmentId: equipment.id, matchedRevisionId: existingByContent.id, resolvedNotes: "Duplicate (content)" },
          });
          continue;
        }
      }

      const pdfData = {
        operatorName: parsed.operator.name,
        operatorAddress: parsed.operator.address,
        operatorPhone: parsed.operator.phone,
        operatorEmail: parsed.operator.email,
        analyzerName: parsed.analyzer.name,
        analyzerSerial: parsed.analyzer.serial,
        location: parsed.location,
        pdfEquipmentName: parsed.equipmentName,
        pdfEquipmentSerial: parsed.equipmentSerial,
        pdfClientAddress: parsed.clientAddress,
        analysisData: parsed.analysisData as any,
        rawText: parsed.rawText,
      };

      // Find existing PENDING revision or create
      const revisionDate = parsed.revisionDate ?? new Date();
      const dateFrom = new Date(revisionDate.getTime() - 7 * 24 * 60 * 60_000);
      const dateTo = new Date(revisionDate.getTime() + 7 * 24 * 60 * 60_000);

      const existingRevision = await prisma.equipmentRevision.findFirst({
        where: { equipmentId: equipment.id, sourceEmailId: null, revisionDate: { gte: dateFrom, lte: dateTo } },
        orderBy: { createdAt: "desc" },
      });

      let revision;
      let hadCompletionData = false;

      if (existingRevision) {
        revision = await prisma.equipmentRevision.update({
          where: { id: existingRevision.id },
          data: { status: "COMPLETED", s3Key, fileName: attachment.filename, sourceEmailId: email.messageId, revisionDate: parsed.revisionDate ?? existingRevision.revisionDate, ...pdfData },
        });
        const linkedApt = await prisma.appointment.findFirst({
          where: { equipmentRevisionId: revision.id, deletedAt: null },
          select: { completionDataJson: true },
        });
        hadCompletionData = !!linkedApt?.completionDataJson;
        console.log(`[email-ingestion] Updated existing revision: ${revision.id}`);
      } else {
        revision = await prisma.equipmentRevision.create({
          data: { equipmentId: equipment.id, revisionDate: parsed.revisionDate ?? new Date(), status: "PENDING", s3Key, fileName: attachment.filename, sourceEmailId: email.messageId, ...pdfData },
        });
        console.log(`[email-ingestion] Created PENDING revision: ${revision.id}`);

        // Try to link appointment
        const candidates = await prisma.appointment.findMany({
          where: { tenantId, deletedAt: null, clientId: client.id, type: "revizie", equipmentRevisionId: null, date: { gte: dateFrom, lte: dateTo } },
          orderBy: { date: "asc" },
        });
        const matched = candidates.find((a) => a.equipmentId === equipment.id)
          ?? candidates.sort((a, b) => Math.abs(a.date.getTime() - revisionDate.getTime()) - Math.abs(b.date.getTime() - revisionDate.getTime()))[0]
          ?? null;

        if (matched) {
          hadCompletionData = !!matched.completionDataJson;
          await prisma.appointment.update({ where: { id: matched.id }, data: { equipmentId: equipment.id, equipmentRevisionId: revision.id } });
          if (hadCompletionData) {
            await prisma.equipmentRevision.update({ where: { id: revision.id }, data: { status: "COMPLETED" } });
          }
        }
      }

      // Activate client on revision (prospect → active)
      await prisma.client.updateMany({
        where: { id: client.id, status: "PROSPECT" },
        data: { status: "ACTIVE" },
      });

      // Generate ISCIR only if both sources available
      if (hadCompletionData) {
        const iscirTemplate = await prisma.documentTemplate.findFirst({
          where: { categoryCode: "REVIZIE_CENTRALA", OR: [{ tenantId }, { tenantId: null }], isActive: true },
        });
        if (iscirTemplate) {
          const document = await prisma.document.create({
            data: { tenantId, templateId: iscirTemplate.id, name: `Revizie ${parsed.clientName ?? ""} ${parsed.clientSurname ?? ""} - ${attachment.filename}`.trim(), status: "PENDING", clients: { create: { clientId: client.id } } },
          });
          await prisma.equipmentRevision.update({ where: { id: revision.id }, data: { iscirDocumentId: document.id } });
          await documentQueue.add("generate", { documentId: document.id, tenantId, clientId: client.id, templateId: iscirTemplate.id, revisionId: revision.id });
          console.log(`[email-ingestion] Queued ISCIR: ${document.id}`);
        }
      }

      // Update log as completed
      await prisma.emailIngestLog.update({
        where: { id: log.id },
        data: { status: "completed", matchedClientId: client.id, matchedEquipmentId: equipment.id, matchedRevisionId: revision.id },
      });

    } catch (err) {
      await prisma.emailIngestLog.update({
        where: { id: log.id },
        data: { status: "failed", errorStep: "unknown", errorMessage: err instanceof Error ? err.message : String(err) },
      });
      console.error(`[email-ingestion] Failed to process ${attachment.filename}:`, err);
    }
  }
}

async function main() {
  const emailQueue = new Queue("email-ingestion", { connection: redisConnection });

  // Add repeatable job (idempotent — BullMQ deduplicates by repeat key)
  await emailQueue.add(
    "poll-inbox",
    {},
    { repeat: { every: POLL_INTERVAL_MS } }
  );

  // Trigger immediate first run (instead of waiting POLL_INTERVAL_MS)
  await emailQueue.add("poll-inbox", {});

  const worker = new Worker("email-ingestion", processJob, {
    connection: redisConnection,
    concurrency: 1,
  });

  worker.on("completed", (job) => {
    console.log(`[email-ingestion] Job ${job?.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[email-ingestion] Job ${job?.id} failed:`, err);
  });

  console.log(`[email-ingestion] Worker started. Polling every ${POLL_INTERVAL_MS / 1000}s.`);

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    console.log("[email-ingestion] Shutting down...");
    await worker.close();
    await emailQueue.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[email-ingestion] Fatal error:", err);
  process.exit(1);
});
