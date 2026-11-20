import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireFeature } from "../../lib/entitlements/index.js";
import { requireRole } from "../../lib/rbac.js";
import * as dossiersService from "./dossiers.service.js";
import * as attachments from "./dossier-attachments.js";
import { readMaterialDoc } from "./attachment-read.js";
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

  // Facturi / certificate de calitate / declarații de conformitate / avize atașate la dosar.
  fastify.get<{ Params: { id: string } }>("/:id/attachments", async (request) => attachments.list(fastify, request.tenantId, request.params.id));

  fastify.post<{ Params: { id: string } }>(
    "/:id/attachments",
    // Citirea automată costă un apel la model: aceeași limită ca la importul rapoartelor.
    { ...WRITE, config: { rateLimit: { max: 60, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const q = z
        .object({
          target: z.enum(attachments.ATTACHMENT_TARGETS),
          kind: z.enum(attachments.ATTACHMENT_KINDS).default("altul"),
          read: z.enum(["0", "1"]).default("1"),
        })
        .parse(request.query);
      const file = await request.file({ limits: { fileSize: 20 * 1024 * 1024 } });
      if (!file) throw fastify.httpErrors.badRequest("Fișierul lipsește");
      let buffer: Buffer;
      try {
        buffer = await file.toBuffer();
      } catch {
        throw fastify.httpErrors.payloadTooLarge("Fișierul depășește 20 MB");
      }
      const r = await attachments.upload(
        fastify,
        request.tenantId,
        request.user.sub,
        request.params.id,
        { target: q.target, kind: q.kind, read: q.read === "1" },
        { buffer, filename: file.filename, mimetype: file.mimetype },
        readMaterialDoc,
      );
      return reply.status(201).send(r);
    },
  );

  fastify.delete<{ Params: { id: string; docId: string } }>("/:id/attachments/:docId", WRITE, async (request) =>
    attachments.remove(fastify, request.tenantId, request.params.id, request.params.docId),
  );

  fastify.patch<{ Params: { id: string } }>("/:id", WRITE, async (request) => {
    return dossiersService.update(fastify, request.tenantId, request.params.id, updateDossierSchema.parse(request.body));
  });

  fastify.post<{ Params: { id: string } }>("/:id/generate", WRITE, async (request, reply) => {
    const { highlightValues } = z.object({ highlightValues: z.boolean().optional() }).parse(request.body ?? {});
    const docs = await dossiersService.generate(fastify, request.tenantId, request.user.sub, request.params.id, { highlightValues });
    return reply.status(202).send({ documents: docs });
  });

  // Fără `requireFeature`: după renunțarea la modul, dosarele vechi se pot șterge în continuare.
  fastify.delete<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => dossiersService.remove(fastify, request.tenantId, request.params.id),
  );
}
