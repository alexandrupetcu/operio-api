import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import { createProjectTypeSchema, updateProjectTypeSchema } from "./project-types.schema.js";
import * as projectTypesService from "./project-types.service.js";

export default async function projectTypesRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async (request) => {
    const { active } = request.query as { active?: string };
    const activeOnly = active === "true" ? true : active === "false" ? false : undefined;
    return projectTypesService.list(fastify, request.tenantId, activeOnly);
  });

  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    return projectTypesService.getById(fastify, request.tenantId, request.params.id);
  });

  fastify.post(
    "/",
    { onRequest: [requireRole("ADMIN")] },
    async (request, reply) => {
      const body = createProjectTypeSchema.parse(request.body);
      const pt = await projectTypesService.create(fastify, request.tenantId, body);
      return reply.status(201).send(pt);
    }
  );

  fastify.patch<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      const body = updateProjectTypeSchema.parse(request.body);
      return projectTypesService.update(fastify, request.tenantId, request.params.id, body);
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      return projectTypesService.remove(fastify, request.tenantId, request.params.id);
    }
  );
}
