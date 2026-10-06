import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import {
  createDistributorSchema,
  updateDistributorSchema,
} from "./distributors.schema.js";
import * as distributorsService from "./distributors.service.js";

export default async function distributorsRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async (request) => {
    const { active } = request.query as { active?: string };
    const activeOnly =
      active === "true" ? true : active === "false" ? false : undefined;
    return distributorsService.list(fastify, request.tenantId, activeOnly);
  });

  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    return distributorsService.getById(
      fastify,
      request.tenantId,
      request.params.id
    );
  });

  fastify.post(
    "/",
    { onRequest: [requireRole("ADMIN")] },
    async (request, reply) => {
      const body = createDistributorSchema.parse(request.body);
      const d = await distributorsService.create(
        fastify,
        request.tenantId,
        body
      );
      return reply.status(201).send(d);
    }
  );

  fastify.patch<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      const body = updateDistributorSchema.parse(request.body);
      return distributorsService.update(
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
      return distributorsService.remove(
        fastify,
        request.tenantId,
        request.params.id
      );
    }
  );
}
