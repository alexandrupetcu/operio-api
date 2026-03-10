import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import { paginationSchema } from "../../lib/pagination.js";
import { createClientSchema, updateClientSchema } from "./clients.schema.js";
import * as clientsService from "./clients.service.js";

export default async function clientsRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async (request) => {
    const query = paginationSchema.parse(request.query);
    const { status } = request.query as Record<string, string>;
    return clientsService.list(fastify, request.tenantId, { ...query, status });
  });

  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    return clientsService.getById(fastify, request.tenantId, request.params.id);
  });

  fastify.post(
    "/",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request, reply) => {
      const body = createClientSchema.parse(request.body);
      const client = await clientsService.create(
        fastify,
        request.tenantId,
        body
      );
      return reply.status(201).send(client);
    }
  );

  fastify.patch<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      const body = updateClientSchema.parse(request.body);
      return clientsService.update(
        fastify,
        request.tenantId,
        request.params.id,
        body
      );
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      return clientsService.remove(
        fastify,
        request.tenantId,
        request.params.id
      );
    }
  );
}
