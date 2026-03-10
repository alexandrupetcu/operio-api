import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import { paginationSchema } from "../../lib/pagination.js";
import {
  createProjectSchema,
  updateProjectSchema,
} from "./projects.schema.js";
import * as projectsService from "./projects.service.js";

export default async function projectsRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async (request) => {
    const query = paginationSchema.parse(request.query);
    const { status, type } = request.query as Record<string, string>;
    return projectsService.list(fastify, request.tenantId, {
      ...query,
      status,
      type,
    });
  });

  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    return projectsService.getById(
      fastify,
      request.tenantId,
      request.params.id
    );
  });

  fastify.post(
    "/",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request, reply) => {
      const body = createProjectSchema.parse(request.body);
      const project = await projectsService.create(
        fastify,
        request.tenantId,
        body
      );
      return reply.status(201).send(project);
    }
  );

  fastify.patch<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      const body = updateProjectSchema.parse(request.body);
      return projectsService.update(
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
      return projectsService.remove(
        fastify,
        request.tenantId,
        request.params.id
      );
    }
  );
}
