import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import {
  generateDocumentsSchema,
  generateBatchSchema,
} from "./documents.schema.js";
import * as documentsService from "./documents.service.js";

export default async function documentsRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  // List documents for a project
  fastify.get<{ Params: { projectId: string } }>(
    "/project/:projectId",
    async (request) => {
      return documentsService.listByProject(
        fastify,
        request.tenantId,
        request.params.projectId
      );
    }
  );

  // Get single document
  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    return documentsService.getById(
      fastify,
      request.tenantId,
      request.params.id
    );
  });

  // Get download URL
  fastify.get<{ Params: { id: string } }>(
    "/:id/download",
    async (request) => {
      return documentsService.getDownloadUrl(
        fastify,
        request.tenantId,
        request.params.id
      );
    }
  );

  // Generate documents from templates
  fastify.post<{ Params: { projectId: string } }>(
    "/project/:projectId/generate",
    { onRequest: [requireRole("ADMIN", "MANAGER", "OPERATOR")] },
    async (request, reply) => {
      const body = generateDocumentsSchema.parse(request.body);
      const docs = await documentsService.generate(
        fastify,
        request.tenantId,
        request.params.projectId,
        body.templateIds,
        request.user.sub
      );
      return reply.status(202).send(docs);
    }
  );

  // Batch generate all documents for a category
  fastify.post<{ Params: { projectId: string } }>(
    "/project/:projectId/generate-batch",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request, reply) => {
      const body = generateBatchSchema.parse(request.body);
      const docs = await documentsService.generateBatch(
        fastify,
        request.tenantId,
        request.params.projectId,
        body.category,
        request.user.sub
      );
      return reply.status(202).send(docs);
    }
  );

  // Upload a document manually
  fastify.post<{ Params: { projectId: string } }>(
    "/project/:projectId/upload",
    async (request, reply) => {
      const file = await request.file();
      if (!file) throw fastify.httpErrors.badRequest("File is required");

      const doc = await documentsService.upload(
        fastify,
        request.tenantId,
        request.params.projectId,
        file,
        request.user.sub
      );
      return reply.status(201).send(doc);
    }
  );

  // Delete document
  fastify.delete<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      return documentsService.remove(
        fastify,
        request.tenantId,
        request.params.id
      );
    }
  );
}
