import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import { paginationSchemaFor } from "../../lib/pagination.js";
import { createUserSchema, updateUserSchema } from "./users.schema.js";
import * as usersService from "./users.service.js";
import { USERS_SORTABLE } from "./users.service.js";

const listQuerySchema = paginationSchemaFor(USERS_SORTABLE);

export default async function usersRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("onRequest", requireRole("ADMIN"));

  fastify.get("/", async (request) => {
    const query = listQuerySchema.parse(request.query);
    return usersService.list(fastify, request.tenantId, query);
  });

  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    return usersService.getById(fastify, request.tenantId, request.params.id);
  });

  fastify.post("/", async (request, reply) => {
    const body = createUserSchema.parse(request.body);
    const user = await usersService.create(fastify, request.tenantId, body, request.user.sub);
    return reply.status(201).send(user);
  });

  // Retrimite invitația (link nou de setare a parolei, 7 zile).
  fastify.post<{ Params: { id: string } }>("/:id/invite", async (request) => {
    const sent = await usersService.sendInvite(fastify, request.tenantId, request.params.id, request.user.sub);
    return { sent };
  });

  fastify.patch<{ Params: { id: string } }>("/:id", async (request) => {
    const body = updateUserSchema.parse(request.body);
    return usersService.update(fastify, request.tenantId, request.params.id, body, request.user.sub);
  });

  fastify.delete<{ Params: { id: string } }>("/:id", async (request) => {
    return usersService.remove(fastify, request.tenantId, request.params.id);
  });

  // ── Mobile devices (phones that logged into the technician app) ────────────
  fastify.get<{ Params: { id: string } }>("/:id/devices", async (request) => {
    return usersService.listDevices(fastify, request.tenantId, request.params.id);
  });

  fastify.post<{ Params: { id: string; deviceId: string } }>(
    "/:id/devices/:deviceId/revoke",
    async (request) => {
      return usersService.revokeDevice(
        fastify,
        request.tenantId,
        request.params.id,
        request.params.deviceId,
        request.user.sub,
      );
    },
  );

  fastify.post<{ Params: { id: string; deviceId: string } }>(
    "/:id/devices/:deviceId/restore",
    async (request) => {
      return usersService.restoreDevice(fastify, request.tenantId, request.params.id, request.params.deviceId);
    },
  );
}
