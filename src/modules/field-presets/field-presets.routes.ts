import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import { recordPresetsSchema, renamePresetSchema } from "./field-presets.schema.js";
import * as service from "./field-presets.service.js";

export default async function fieldPresetsRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  // Catalogul firmei, grupat pe vocabular: { material: [...], furnizor: [...] }
  fastify.get("/", async (request) => {
    const { detailed, scope } = request.query as { detailed?: string; scope?: string };
    if (detailed === "true") return service.listDetailed(fastify, request.tenantId, scope);
    return service.list(fastify, request.tenantId);
  });

  // Înregistrează folosirea unei valori (una sau un lot). Orice utilizator
  // autentificat poate scrie — instalatorii de pe teren sunt exact cei care
  // îmbogățesc vocabularul.
  fastify.post("/", async (request) => {
    const body = recordPresetsSchema.parse(request.body);
    return service.record(fastify, request.tenantId, body);
  });

  // Redenumire; dacă noul nume există deja, cele două intrări se contopesc.
  fastify.patch<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      const body = renamePresetSchema.parse(request.body);
      return service.rename(fastify, request.tenantId, request.params.id, body.value);
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      return service.remove(fastify, request.tenantId, request.params.id);
    }
  );
}
