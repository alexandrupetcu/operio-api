import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import { paginationSchema } from "../../lib/pagination.js";
import { createTaskSchema, updateTaskSchema } from "./tasks.schema.js";
import * as tasksService from "./tasks.service.js";

export default async function tasksRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async (request) => {
    const query = paginationSchema.parse(request.query);
    const { status, assignedUserId, projectId, workflowInstanceId } =
      request.query as Record<string, string>;
    return tasksService.list(fastify, request.tenantId, {
      ...query,
      status,
      assignedUserId,
      projectId,
      workflowInstanceId,
    });
  });

  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    return tasksService.getById(fastify, request.tenantId, request.params.id);
  });

  fastify.post(
    "/",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request, reply) => {
      const body = createTaskSchema.parse(request.body);
      const task = await tasksService.create(fastify, request.tenantId, body);
      return reply.status(201).send(task);
    }
  );

  fastify.patch<{ Params: { id: string } }>("/:id", async (request) => {
    const body = updateTaskSchema.parse(request.body);
    return tasksService.update(
      fastify,
      request.tenantId,
      request.params.id,
      body
    );
  });

  fastify.post<{ Params: { id: string } }>(
    "/:id/complete",
    async (request) => {
      return tasksService.complete(
        fastify,
        request.tenantId,
        request.params.id
      );
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      return tasksService.remove(
        fastify,
        request.tenantId,
        request.params.id
      );
    }
  );
}
