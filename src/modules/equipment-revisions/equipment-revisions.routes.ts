import type { FastifyInstance } from "fastify";
import { Queue } from "bullmq";
import { requireRole } from "../../lib/rbac.js";
import { redisConnection } from "../../config/redis.js";
import { createRevisionSchema, updateRevisionSchema } from "./equipment-revisions.schema.js";
import * as revisionService from "./equipment-revisions.service.js";
import { uploadFile, getPresignedUrl } from "../../lib/s3.js";

const revisionQueue = new Queue("revision-processing", {
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
      const s3Key = `${request.tenantId}/revisions/${request.params.equipmentId}/${Date.now()}-${file.filename}`;
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
