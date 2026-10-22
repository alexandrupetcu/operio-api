import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import { resolveApptScope } from "../appointments/scope.js";
import * as revisionsService from "./revisions.service.js";
import { createDirectRevisionSchema, listRevisionsQuerySchema } from "./revisions.schema.js";

/** Secțiunea „Revizii”: lista tuturor reviziilor firmei + revizie fără programare. */
export default async function revisionsRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async (request) => {
    const scope = await resolveApptScope(fastify, request);
    return revisionsService.list(fastify, request.tenantId, listRevisionsQuerySchema.parse(request.query), scope);
  });

  fastify.post("/", { onRequest: [requireRole("ADMIN", "MANAGER", "OPERATOR")] }, async (request, reply) => {
    const body = createDirectRevisionSchema.parse(request.body);
    const rawKey = request.headers["idempotency-key"];
    const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    const appt = await revisionsService.createDirect(fastify, request.tenantId, body, idempotencyKey?.trim() || null);
    return reply.status(201).send(appt);
  });
}
