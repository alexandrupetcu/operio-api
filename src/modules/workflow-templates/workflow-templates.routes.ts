import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import {
  createTemplateSchema,
  updateTemplateSchema,
  updateStepsSchema,
} from "./workflow-templates.schema.js";
import * as service from "./workflow-templates.service.js";

export default async function workflowTemplatesRoutes(
  fastify: FastifyInstance
) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async (request) => {
    const { projectType } = request.query as Record<string, string>;
    return service.list(fastify, request.tenantId, projectType);
  });

  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    return service.getById(fastify, request.tenantId, request.params.id);
  });

  fastify.post(
    "/",
    { onRequest: [requireRole("ADMIN")] },
    async (request, reply) => {
      const body = createTemplateSchema.parse(request.body);
      const template = await service.create(fastify, request.tenantId, body);
      return reply.status(201).send(template);
    }
  );

  fastify.patch<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      const body = updateTemplateSchema.parse(request.body);
      return service.update(
        fastify,
        request.tenantId,
        request.params.id,
        body
      );
    }
  );

  fastify.put<{ Params: { id: string } }>(
    "/:id/steps",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      const body = updateStepsSchema.parse(request.body);
      return service.updateSteps(
        fastify,
        request.tenantId,
        request.params.id,
        body
      );
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      return service.remove(fastify, request.tenantId, request.params.id);
    }
  );
}
