import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Queue } from "bullmq";
import { requireRole } from "../../lib/rbac.js";
import { redisConnection } from "../../config/redis.js";
import {
  matchOrCreateEquipment,
} from "../equipment-revisions/revision-matching.js";

const documentQueue = new Queue("document-generation", { connection: redisConnection });

export default async function emailLogsRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("onRequest", requireRole("ADMIN", "MANAGER"));

  // List logs with filters
  fastify.get<{
    Querystring: { status?: string; limit?: string; offset?: string };
  }>("/", async (request) => {
    const { status, limit, offset } = request.query as Record<string, string>;
    const where = {
      tenantId: request.tenantId,
      ...(status && { status }),
    };
    const [data, total] = await Promise.all([
      fastify.prisma.emailIngestLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit ? parseInt(limit) : 50,
        skip: offset ? parseInt(offset) : 0,
      }),
      fastify.prisma.emailIngestLog.count({ where }),
    ]);
    return { data, total };
  });

  // Stats (for dashboard)
  fastify.get("/stats", async (request) => {
    const tenantId = request.tenantId;
    const [needsReview, failed, completed] = await Promise.all([
      fastify.prisma.emailIngestLog.count({ where: { tenantId, status: "needs_review" } }),
      fastify.prisma.emailIngestLog.count({ where: { tenantId, status: "failed" } }),
      fastify.prisma.emailIngestLog.count({ where: { tenantId, status: "completed" } }),
    ]);
    return { needsReview, failed, completed };
  });

  // Get single log
  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    const log = await fastify.prisma.emailIngestLog.findFirst({
      where: { id: request.params.id, tenantId: request.tenantId },
    });
    if (!log) throw fastify.httpErrors.notFound("Log not found");
    return log;
  });

  // Resolve — operator selects the correct client, then system re-processes
  fastify.post<{ Params: { id: string } }>(
    "/:id/resolve",
    async (request) => {
      const body = z
        .object({
          clientId: z.string().cuid(),
          notes: z.string().optional(),
        })
        .parse(request.body);

      const log = await fastify.prisma.emailIngestLog.findFirst({
        where: { id: request.params.id, tenantId: request.tenantId, status: "needs_review" },
      });
      if (!log) throw fastify.httpErrors.notFound("Log not found or not in needs_review status");

      // Verify client belongs to tenant
      const client = await fastify.prisma.client.findFirst({
        where: { id: body.clientId, tenantId: request.tenantId },
      });
      if (!client) throw fastify.httpErrors.notFound("Client not found");

      const tenantId = request.tenantId;
      const parsed = log.parsedData as Record<string, unknown> | null;

      // Equipment matching (always resolves)
      const equipment = await matchOrCreateEquipment(fastify.prisma, client.id, {
        equipmentName: log.parsedEquipmentName,
        equipmentSerial: log.parsedEquipmentSerial,
        fuel: (parsed as Record<string, string>)?.combustibil ?? undefined,
      });

      // Find existing PENDING revision on this equipment (created by finalize or earlier)
      const existingRevision = await fastify.prisma.equipmentRevision.findFirst({
        where: {
          equipmentId: equipment.id,
          createdAt: { gte: new Date(Date.now() - 7 * 24 * 3600_000) },
        },
        orderBy: { createdAt: "desc" },
      });

      const pdfData = {
        operatorName: (parsed as any)?.operator?.name ?? null,
        analyzerName: (parsed as any)?.analyzer?.name ?? null,
        analyzerSerial: (parsed as any)?.analyzer?.serial ?? null,
        location: (parsed as any)?.location ?? null,
        pdfEquipmentName: log.parsedEquipmentName,
        pdfEquipmentSerial: log.parsedEquipmentSerial,
        analysisData: (parsed ?? null) as any,
        rawText: (parsed as any)?.rawText ?? null,
      };

      let revision;
      if (existingRevision) {
        revision = await fastify.prisma.equipmentRevision.update({
          where: { id: existingRevision.id },
          data: {
            status: "COMPLETED",
            s3Key: log.s3Key,
            fileName: log.fileName,
            sourceEmailId: log.emailMessageId,
            ...pdfData,
          },
        });
      } else {
        revision = await fastify.prisma.equipmentRevision.create({
          data: {
            equipmentId: equipment.id,
            revisionDate: new Date(),
            status: "PENDING",
            s3Key: log.s3Key,
            fileName: log.fileName,
            sourceEmailId: log.emailMessageId,
            ...pdfData,
          },
        });
      }

      // Try to link appointment
      let hadCompletionData = false;
      const linkedApt = await fastify.prisma.appointment.findFirst({
        where: { equipmentRevisionId: revision.id, deletedAt: null },
        select: { completionDataJson: true },
      });
      hadCompletionData = !!linkedApt?.completionDataJson;

      const now = new Date();
      const dateFrom = new Date(now.getTime() - 7 * 24 * 3600_000);
      const dateTo = new Date(now.getTime() + 7 * 24 * 3600_000);

      if (!linkedApt) {
        const candidates = await fastify.prisma.appointment.findMany({
          where: { tenantId, deletedAt: null, clientId: client.id, type: "revizie", equipmentRevisionId: null, date: { gte: dateFrom, lte: dateTo } },
        });
        const matched = candidates[0] ?? null;
        if (matched) {
          hadCompletionData = !!matched.completionDataJson;
          await fastify.prisma.appointment.update({
            where: { id: matched.id },
            data: { equipmentId: equipment.id, equipmentRevisionId: revision.id },
          });
          if (hadCompletionData) {
            await fastify.prisma.equipmentRevision.update({ where: { id: revision.id }, data: { status: "COMPLETED" } });
          }
        }
      }

      // Queue ISCIR if both sources available
      if (hadCompletionData) {
        const iscirTemplate = await fastify.prisma.documentTemplate.findFirst({
          where: { categoryCode: "REVIZIE_CENTRALA", OR: [{ tenantId }, { tenantId: null }], isActive: true },
        });
        if (iscirTemplate) {
          const document = await fastify.prisma.document.create({
            data: { tenantId, templateId: iscirTemplate.id, name: `Revizie (reconciliat) - ${log.fileName}`, status: "PENDING", clients: { create: { clientId: client.id } } },
          });
          await fastify.prisma.equipmentRevision.update({ where: { id: revision.id }, data: { iscirDocumentId: document.id } });
          await documentQueue.add("generate", { documentId: document.id, tenantId, clientId: client.id, templateId: iscirTemplate.id, revisionId: revision.id });
        }
      }

      // Update log
      return fastify.prisma.emailIngestLog.update({
        where: { id: log.id },
        data: {
          status: "completed",
          resolvedClientId: client.id,
          matchedClientId: client.id,
          matchedEquipmentId: equipment.id,
          matchedRevisionId: revision.id,
          resolvedById: request.user.sub,
          resolvedAt: new Date(),
          resolvedNotes: body.notes || "Reconciliat manual",
          errorMessage: null,
          errorStep: null,
        },
      });
    }
  );

  // Merge two revisions: one with technician report + one with PDF data → single COMPLETED revision
  fastify.post(
    "/merge-revisions",
    async (request) => {
      const body = z
        .object({
          revisionWithReport: z.string().cuid(), // has appointment + completionDataJson
          revisionWithPdf: z.string().cuid(),     // has sourceEmailId + analysisData
        })
        .parse(request.body);

      const tenantId = request.tenantId;

      const reportRevision = await fastify.prisma.equipmentRevision.findUnique({
        where: { id: body.revisionWithReport },
        include: {
          equipment: { select: { id: true, clientId: true, client: { select: { tenantId: true } } } },
          appointment: { select: { id: true, completionDataJson: true, clientId: true } },
        },
      });
      if (!reportRevision || reportRevision.equipment.client.tenantId !== tenantId) {
        throw fastify.httpErrors.notFound("Revision with report not found");
      }
      if (!reportRevision.appointment?.completionDataJson) {
        throw fastify.httpErrors.badRequest("Revision does not have a technician report");
      }

      const pdfRevision = await fastify.prisma.equipmentRevision.findUnique({
        where: { id: body.revisionWithPdf },
        include: { equipment: { select: { client: { select: { tenantId: true } } } } },
      });
      if (!pdfRevision || pdfRevision.equipment.client.tenantId !== tenantId) {
        throw fastify.httpErrors.notFound("Revision with PDF not found");
      }
      if (!pdfRevision.sourceEmailId) {
        throw fastify.httpErrors.badRequest("Revision does not have PDF data");
      }

      // Merge: copy PDF data onto the report revision
      const merged = await fastify.prisma.equipmentRevision.update({
        where: { id: reportRevision.id },
        data: {
          status: "COMPLETED",
          s3Key: pdfRevision.s3Key,
          fileName: pdfRevision.fileName,
          sourceEmailId: pdfRevision.sourceEmailId,
          operatorName: pdfRevision.operatorName,
          operatorAddress: pdfRevision.operatorAddress,
          operatorPhone: pdfRevision.operatorPhone,
          operatorEmail: pdfRevision.operatorEmail,
          analyzerName: pdfRevision.analyzerName,
          analyzerSerial: pdfRevision.analyzerSerial,
          location: pdfRevision.location ?? reportRevision.location,
          pdfEquipmentName: pdfRevision.pdfEquipmentName,
          pdfEquipmentSerial: pdfRevision.pdfEquipmentSerial,
          pdfClientAddress: pdfRevision.pdfClientAddress,
          analysisData: pdfRevision.analysisData ?? undefined,
          rawText: pdfRevision.rawText,
          revisionDate: pdfRevision.revisionDate ?? reportRevision.revisionDate,
        },
      });

      // Delete the PDF-only revision (now merged)
      // First move any appointments pointing to it
      await fastify.prisma.appointment.updateMany({
        where: { equipmentRevisionId: pdfRevision.id },
        data: { equipmentRevisionId: reportRevision.id },
      });
      await fastify.prisma.equipmentRevision.delete({ where: { id: pdfRevision.id } });

      // Queue ISCIR document generation with both sources
      const clientId = reportRevision.appointment.clientId ?? reportRevision.equipment.clientId;
      const iscirTemplate = await fastify.prisma.documentTemplate.findFirst({
        where: { categoryCode: "REVIZIE_CENTRALA", OR: [{ tenantId }, { tenantId: null }], isActive: true },
      });
      if (iscirTemplate && clientId) {
        const document = await fastify.prisma.document.create({
          data: {
            tenantId,
            templateId: iscirTemplate.id,
            name: `Revizie (merge) - ${pdfRevision.fileName ?? ""}`.trim(),
            status: "PENDING",
            clients: { create: { clientId } },
          },
        });
        await fastify.prisma.equipmentRevision.update({
          where: { id: merged.id },
          data: { iscirDocumentId: document.id },
        });
        await documentQueue.add("generate", {
          documentId: document.id,
          tenantId,
          clientId,
          templateId: iscirTemplate.id,
          revisionId: merged.id,
        });
      }

      return merged;
    }
  );
}
