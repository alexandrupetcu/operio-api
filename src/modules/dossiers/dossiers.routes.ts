import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireFeature } from "../../lib/entitlements/index.js";
import { requireRole } from "../../lib/rbac.js";
import * as dossiersService from "./dossiers.service.js";
import { createDossierSchema, listDossiersQuerySchema, updateDossierSchema } from "./dossiers.schema.js";

const WRITE = { onRequest: [requireRole("ADMIN", "MANAGER", "OPERATOR")], preHandler: [requireFeature("documents.dossiers")] };

/** Secțiunea „Dosare” — Carte Branșament / Conductă / Dosar ISCIR fără flux de proiect. */
export default async function dossiersRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async (request) => {
    return dossiersService.list(fastify, request.tenantId, listDossiersQuerySchema.parse(request.query));
  });

  fastify.get("/groups", async (request) => dossiersService.listGroups(fastify, request.tenantId));

  fastify.get("/fields", async (request) => {
    const { templateGroupId } = z.object({ templateGroupId: z.string().cuid() }).parse(request.query);
    return dossiersService.getFields(fastify, request.tenantId, templateGroupId);
  });

  fastify.get<{ Params: { id: string } }>("/:id", async (request) => dossiersService.get(fastify, request.tenantId, request.params.id));

  fastify.post("/", WRITE, async (request, reply) => {
    const d = await dossiersService.create(fastify, request.tenantId, createDossierSchema.parse(request.body));
    return reply.status(201).send(d);
  });

  fastify.patch<{ Params: { id: string } }>("/:id", WRITE, async (request) => {
    return dossiersService.update(fastify, request.tenantId, request.params.id, updateDossierSchema.parse(request.body));
  });

  fastify.post<{ Params: { id: string } }>("/:id/generate", WRITE, async (request, reply) => {
    const docs = await dossiersService.generate(fastify, request.tenantId, request.user.sub, request.params.id);
    return reply.status(202).send({ documents: docs });
  });

  // Fără `requireFeature`: după renunțarea la modul, dosarele vechi se pot șterge în continuare.
  fastify.delete<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => dossiersService.remove(fastify, request.tenantId, request.params.id),
  );
}
