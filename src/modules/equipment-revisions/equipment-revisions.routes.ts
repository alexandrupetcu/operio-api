import type { FastifyInstance } from "fastify";
import { Queue } from "bullmq";
import { requireRole } from "../../lib/rbac.js";
import { redisConnection } from "../../config/redis.js";
import { createRevisionSchema, updateRevisionSchema } from "./equipment-revisions.schema.js";
import * as revisionService from "./equipment-revisions.service.js";
import { uploadFile, getPresignedUrl } from "../../lib/s3.js";
import { safeS3Filename } from "../../lib/safe-filename.js";
import { parseRevisionPdf } from "./revision-pdf-parser.js";

const revisionQueue = new Queue("revision-processing", {
  connection: redisConnection,
});

const documentQueue = new Queue("document-generation", {
  connection: redisConnection,
});

type RevisionParams = {
  Params: { id: string; equipmentId: string };
};

type SingleRevisionParams = {
  Params: { id: string; equipmentId: string; revisionId: string };
};

export default async function equipmentRevisionsRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  // List revisions for an equipment
  fastify.get<RevisionParams>(
    "/:id/equipment/:equipmentId/revisions",
    async (request) => {
      return revisionService.listByEquipment(
        fastify,
        request.tenantId,
        request.params.id,
        request.params.equipmentId
      );
    }
  );

  // Get single revision
  fastify.get<SingleRevisionParams>(
    "/:id/equipment/:equipmentId/revisions/:revisionId",
    async (request) => {
      return revisionService.getById(
        fastify,
        request.tenantId,
        request.params.id,
        request.params.equipmentId,
        request.params.revisionId
      );
    }
  );

  // Upload PDF revision — uploads to S3, creates PENDING record, queues parsing
  fastify.post<RevisionParams>(
    "/:id/equipment/:equipmentId/revisions/upload",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request, reply) => {
      const file = await request.file();
      if (!file) throw fastify.httpErrors.badRequest("No file uploaded");

      const buffer = await file.toBuffer();

      // Upload to S3 immediately
      const s3Key = `${request.tenantId}/revisions/${request.params.equipmentId}/${Date.now()}-${safeS3Filename(file.filename)}`;
      await uploadFile(s3Key, buffer, file.mimetype);

      // Create revision record with PENDING status
      const revision = await revisionService.create(
        fastify,
        request.tenantId,
        request.params.id,
        request.params.equipmentId,
        {
          revisionDate: new Date().toISOString(),
          s3Key,
          fileName: file.filename,
        },
        "PENDING"
      );

      // Queue PDF parsing job
      await revisionQueue.add("parse-revision-pdf", {
        revisionId: revision.id,
        s3Key,
        tenantId: request.tenantId,
      });

      return reply.status(201).send(revision);
    }
  );

  // Create revision manually (without PDF)
  fastify.post<RevisionParams>(
    "/:id/equipment/:equipmentId/revisions",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request, reply) => {
      const body = createRevisionSchema.parse(request.body);
      const revision = await revisionService.create(
        fastify,
        request.tenantId,
        request.params.id,
        request.params.equipmentId,
        body
      );
      return reply.status(201).send(revision);
    }
  );

  // Update revision (date override, notes, etc.)
  fastify.patch<SingleRevisionParams>(
    "/:id/equipment/:equipmentId/revisions/:revisionId",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      const body = updateRevisionSchema.parse(request.body);
      return revisionService.update(
        fastify,
        request.tenantId,
        request.params.id,
        request.params.equipmentId,
        request.params.revisionId,
        body
      );
    }
  );

  // Delete revision
  fastify.delete<SingleRevisionParams>(
    "/:id/equipment/:equipmentId/revisions/:revisionId",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      return revisionService.remove(
        fastify,
        request.tenantId,
        request.params.id,
        request.params.equipmentId,
        request.params.revisionId
      );
    }
  );

  // Directly attach a Seitron analyzer PDF to THIS revision (alternative to the
  // email-ingestion flow): parse it, fill the revision with readings + analyzer
  // data, mark it COMPLETED, and (re)generate the ISCIR document if the linked
  // appointment already has the technician's report.
  fastify.post<SingleRevisionParams>(
    "/:id/equipment/:equipmentId/revisions/:revisionId/upload-pdf",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request, reply) => {
      const { id: clientId, equipmentId, revisionId } = request.params;
      const tenantId = request.tenantId;

      const rev = await fastify.prisma.equipmentRevision.findFirst({
        where: { id: revisionId, equipmentId, equipment: { clientId, client: { tenantId } } },
        select: { id: true, iscirDocumentId: true, revisionDate: true, equipment: { select: { clientId: true } } },
      });
      if (!rev) throw fastify.httpErrors.notFound("Revision not found");

      const file = await request.file();
      if (!file) throw fastify.httpErrors.badRequest("No file uploaded");
      if (file.mimetype !== "application/pdf") {
        throw fastify.httpErrors.badRequest("Doar fișiere PDF sunt acceptate");
      }
      const buffer = await file.toBuffer();

      const s3Key = `${tenantId}/revisions/${equipmentId}/${Date.now()}-${safeS3Filename(file.filename)}`;
      await uploadFile(s3Key, buffer, file.mimetype);

      const parsed = await parseRevisionPdf(buffer);

      await fastify.prisma.equipmentRevision.update({
        where: { id: revisionId },
        data: {
          status: "COMPLETED",
          s3Key,
          fileName: file.filename,
          sourceEmailId: `upload:${revisionId}`,
          revisionDate: parsed.revisionDate ?? rev.revisionDate,
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
          analysisData: parsed.analysisData as never,
          rawText: parsed.rawText,
        },
      });

      // (Re)generate the ISCIR document when the report is already filled in.
      const linkedApt = await fastify.prisma.appointment.findFirst({
        where: { equipmentRevisionId: revisionId, deletedAt: null },
        select: { completionDataJson: true },
      });
      let iscirQueued = false;
      if (linkedApt?.completionDataJson) {
        const tpl = await fastify.prisma.documentTemplate.findFirst({
          where: { categoryCode: "REVIZIE_CENTRALA", OR: [{ tenantId }, { tenantId: null }], isActive: true },
          select: { id: true },
        });
        if (tpl) {
          let documentId = rev.iscirDocumentId;
          if (documentId) {
            await fastify.prisma.document.update({
              where: { id: documentId },
              data: { status: "PENDING", errorMessage: null },
            });
          } else {
            const doc = await fastify.prisma.document.create({
              data: {
                tenantId,
                templateId: tpl.id,
                name: "Raport Revizie Centrală (ISCIR)",
                status: "PENDING",
                clients: { create: { clientId: rev.equipment.clientId } },
              },
            });
            documentId = doc.id;
            await fastify.prisma.equipmentRevision.update({
              where: { id: revisionId },
              data: { iscirDocumentId: documentId },
            });
          }
          await documentQueue.add("generate", { documentId, tenantId, clientId: rev.equipment.clientId, templateId: tpl.id, revisionId });
          iscirQueued = true;
        }
      }

      return reply.status(200).send({ revisionId, iscirQueued });
    }
  );

  // Regenerate the ISCIR document for this revision — re-renders with the
  // current template + latest data (readings + appointment report). Reuses the
  // existing document if present, otherwise creates one.
  fastify.post<SingleRevisionParams>(
    "/:id/equipment/:equipmentId/revisions/:revisionId/regenerate-documents",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request, reply) => {
      const { id: clientId, equipmentId, revisionId } = request.params;
      const tenantId = request.tenantId;

      const revision = await fastify.prisma.equipmentRevision.findFirst({
        where: {
          id: revisionId,
          equipmentId,
          equipment: { clientId, client: { tenantId } },
        },
        select: { id: true, iscirDocumentId: true, equipment: { select: { clientId: true } } },
      });
      if (!revision) throw fastify.httpErrors.notFound("Revision not found");

      let documentId = revision.iscirDocumentId;
      let templateId: string | null = null;

      if (documentId) {
        const doc = await fastify.prisma.document.findUnique({
          where: { id: documentId },
          select: { templateId: true },
        });
        templateId = doc?.templateId ?? null;
        await fastify.prisma.document.update({
          where: { id: documentId },
          data: { status: "PENDING", errorMessage: null },
        });
      }

      if (!templateId) {
        const tpl = await fastify.prisma.documentTemplate.findFirst({
          where: { categoryCode: "REVIZIE_CENTRALA", OR: [{ tenantId }, { tenantId: null }], isActive: true },
          select: { id: true },
        });
        if (!tpl) throw fastify.httpErrors.badRequest("No REVIZIE_CENTRALA template configured");
        templateId = tpl.id;
      }

      if (!documentId) {
        const doc = await fastify.prisma.document.create({
          data: {
            tenantId,
            templateId,
            name: "Raport Revizie Centrală (ISCIR)",
            status: "PENDING",
            clients: { create: { clientId: revision.equipment.clientId } },
          },
        });
        documentId = doc.id;
        await fastify.prisma.equipmentRevision.update({
          where: { id: revisionId },
          data: { iscirDocumentId: documentId },
        });
      }

      await documentQueue.add("generate", {
        documentId,
        tenantId,
        clientId: revision.equipment.clientId,
        templateId,
        revisionId,
      });

      return reply.status(202).send({ documentId, status: "queued" });
    }
  );

  // Download revision PDF
  fastify.get<SingleRevisionParams>(
    "/:id/equipment/:equipmentId/revisions/:revisionId/download",
    async (request) => {
      const revision = await revisionService.getById(
        fastify,
        request.tenantId,
        request.params.id,
        request.params.equipmentId,
        request.params.revisionId
      );
      if (!revision.s3Key) throw fastify.httpErrors.notFound("No PDF attached");
      const url = await getPresignedUrl(revision.s3Key);
      return { url };
    }
  );
}
