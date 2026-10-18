import { Worker, type Job } from "bullmq";
import { PrismaClient } from "@prisma/client";
import { redisConnection } from "../config/redis.js";
import { getFileStream } from "../lib/s3.js";
import { detectSource, extractPdfText } from "../lib/report-sources/index.js";
import { getReportSourcesSettings } from "../modules/tenant/report-sources-settings.js";
import { revisionDataFromParsed } from "../modules/equipment-revisions/equipment-revisions.service.js";

interface RevisionJobData {
  revisionId: string;
  s3Key: string;
  tenantId: string;
}

const prisma = new PrismaClient();

async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const DAY_MS = 24 * 3600_000;

/**
 * Leagă revizia de programarea de revizie a clientului din aceeași zi (±1 zi)
 * care nu e finalizată și nu are încă un fișier de revizie — doar când
 * candidatul e unic; altfel rămâne de legat manual.
 */
async function linkSameDayAppointment(
  tenantId: string,
  revisionId: string,
  equipmentId: string,
  revisionDate: Date,
): Promise<string | null> {
  const equipment = await prisma.equipment.findUnique({
    where: { id: equipmentId },
    select: { clientId: true },
  });
  if (!equipment) return null;

  const candidates = await prisma.appointment.findMany({
    where: {
      tenantId,
      deletedAt: null,
      clientId: equipment.clientId,
      type: "revizie",
      status: { notIn: ["completed", "cancelled"] },
      date: { gte: new Date(revisionDate.getTime() - DAY_MS), lte: new Date(revisionDate.getTime() + DAY_MS) },
      OR: [{ equipmentRevisionId: null }, { equipmentRevision: { s3Key: null, analyzerName: null } }],
    },
    select: { id: true },
  });
  if (candidates.length !== 1) return null;

  await prisma.appointment.update({
    where: { id: candidates[0].id },
    data: { equipmentId, equipmentRevisionId: revisionId },
  });
  return candidates[0].id;
}

async function processJob(job: Job<RevisionJobData>) {
  const { revisionId, s3Key, tenantId } = job.data;
  console.log(`[${revisionId}] Starting job`);

  await prisma.equipmentRevision.update({
    where: { id: revisionId },
    data: { status: "PROCESSING" },
  });

  try {
    // Download PDF from S3
    const stream = await getFileStream(s3Key);
    if (!stream) throw new Error("PDF file not found in S3");
    const buffer = await streamToBuffer(stream);
    console.log(`[${revisionId}] Downloaded ${buffer.length} bytes`);

    // Extract text from PDF
    const rawText = await extractPdfText(buffer);
    console.log(`[${revisionId}] Extracted ${rawText.length} chars`);

    // Pick the source from the registry (Seitron regex, AI, or attach-only) and parse
    const { source, score } = detectSource(rawText);
    const settings = await getReportSourcesSettings(prisma, tenantId);
    const parsed = await source.parse({ buffer, text: rawText, mapping: settings.sourceMappings[source.id] });
    parsed.analysisData._source = source.id;
    console.log(`[${revisionId}] Parsed with ${source.id} (score ${score.toFixed(2)}): operator=${parsed.operator.name}`);

    // Update revision with parsed data
    const revision = await prisma.equipmentRevision.update({
      where: { id: revisionId },
      data: {
        status: "COMPLETED",
        ...(parsed.revisionDate && { revisionDate: parsed.revisionDate }),
        ...revisionDataFromParsed(parsed),
      },
    });

    // Link to the client's same-day revizie appointment (only when unambiguous)
    if (tenantId) {
      try {
        const linked = await linkSameDayAppointment(tenantId, revisionId, revision.equipmentId, revision.revisionDate);
        if (linked) console.log(`[${revisionId}] Linked to appointment ${linked}`);
      } catch (err) {
        console.error(`[${revisionId}] Appointment link failed:`, err instanceof Error ? err.message : err);
      }
    }

    // Update equipment name/serial from PDF if available
    if (parsed.equipmentName || parsed.equipmentSerial) {
      const equipment = await prisma.equipment.findUnique({
        where: { id: revision.equipmentId },
        select: { name: true, serial: true },
      });
      if (equipment) {
        const updates: Record<string, string> = {};
        if (parsed.equipmentName) updates.name = parsed.equipmentName;
        if (parsed.equipmentSerial) updates.serial = parsed.equipmentSerial;
        if (Object.keys(updates).length > 0) {
          await prisma.equipment.update({
            where: { id: revision.equipmentId },
            data: updates,
          });
          console.log(`[${revisionId}] Updated equipment: ${JSON.stringify(updates)}`);
        }
      }
    }
    console.log(`[${revisionId}] COMPLETED`);

    return { success: true, revisionId };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`[${revisionId}] Error:`, errorMessage);

    try {
      await prisma.equipmentRevision.update({
        where: { id: revisionId },
        data: { status: "FAILED" },
      });
    } catch {
      // revision may have been deleted
    }

    throw error;
  }
}

// Start worker
async function main() {
  const worker = new Worker("revision-processing", processJob, {
    connection: redisConnection,
    concurrency: 2,
  });

  worker.on("completed", (job) => {
    console.log(`Revision parsing completed: ${job.data.revisionId}`);
  });

  worker.on("failed", (job, err) => {
    console.error(`Revision parsing failed for ${job?.data.revisionId}:`, err.message);
  });

  console.log("Revision processing worker started");

  process.on("SIGTERM", async () => {
    await worker.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}

main().catch(console.error);
