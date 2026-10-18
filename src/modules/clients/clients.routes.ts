import { requireFeature } from "../../lib/entitlements/index.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import { paginationSchemaFor } from "../../lib/pagination.js";
import {
  createClientSchema,
  updateClientSchema,
  equipmentInputSchema,
  clientAddressInputSchema,
  gasInstallationInputSchema,
  quickDossierInputSchema,
  updateQuickDossierSchema,
} from "./clients.schema.js";
import * as clientsService from "./clients.service.js";
import { CLIENTS_SORTABLE } from "./clients.service.js";
import {
  ImportFileError,
  MAX_FILE_BYTES,
  importClients,
  mappingSchema,
  parseUpload,
  suggestMapping,
} from "./clients-import.js";
import { invalidateReadiness } from "../tenant/readiness.js";
import { invalidateDashboardCache } from "../../lib/dashboard-cache.js";

const listQuerySchema = paginationSchemaFor(CLIENTS_SORTABLE);

/** Citește multipart-ul unui import: fișierul din câmpul `file` + câmpurile text. */
async function readImportUpload(fastify: FastifyInstance, request: FastifyRequest) {
  let file: { buffer: Buffer; filename: string; mimetype: string } | null = null;
  const fields: Record<string, string> = {};
  try {
    for await (const part of request.parts({ limits: { fileSize: MAX_FILE_BYTES, files: 1 } })) {
      if (part.type === "file") {
        if (part.fieldname !== "file") {
          await part.toBuffer(); // consumăm fluxul ca să nu blocăm parserul
          continue;
        }
        file = { buffer: await part.toBuffer(), filename: part.filename ?? "import", mimetype: part.mimetype ?? "" };
      } else {
        fields[part.fieldname] = String(part.value ?? "");
      }
    }
  } catch (err) {
    if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
      throw fastify.httpErrors.payloadTooLarge("Fișierul depășește 5 MB");
    }
    throw err;
  }
  if (!file) throw fastify.httpErrors.badRequest("Lipsește fișierul (câmpul „file”)");
  return { file, fields };
}

async function parseOr400(fastify: FastifyInstance, file: { buffer: Buffer; filename: string; mimetype: string }) {
  try {
    return await parseUpload(file.buffer, file.filename, file.mimetype);
  } catch (err) {
    if (err instanceof ImportFileError) throw fastify.httpErrors.badRequest(err.message);
    throw err;
  }
}

export default async function clientsRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  // === Import din Excel/CSV (onboarding) ===
  // Previzualizare: antet, primele rânduri și maparea propusă a coloanelor.
  fastify.post(
    "/import/preview",
    {
      onRequest: [requireRole("ADMIN", "MANAGER")],
      config: { rateLimit: { max: 30, timeWindow: "1 hour" } },
    },
    async (request) => {
      const { file } = await readImportUpload(fastify, request);
      const sheet = await parseOr400(fastify, file);
      return {
        headers: sheet.headers,
        rows: sheet.rows.slice(0, 5),
        totalRows: sheet.rows.length,
        suggestedMapping: suggestMapping(sheet.headers),
      };
    },
  );

  // Importul propriu-zis, cu maparea confirmată (`mapping` = JSON, `skipDuplicates` = "true"/"false").
  fastify.post(
    "/import",
    {
      onRequest: [requireRole("ADMIN", "MANAGER")],
      config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
    },
    async (request) => {
      const { file, fields } = await readImportUpload(fastify, request);
      let mappingRaw: unknown;
      try {
        mappingRaw = JSON.parse(fields.mapping ?? "");
      } catch {
        throw fastify.httpErrors.badRequest("Câmpul „mapping” trebuie să fie JSON valid");
      }
      const mapping = mappingSchema.parse(mappingRaw);
      const skipDuplicates = fields.skipDuplicates === undefined ? true : fields.skipDuplicates !== "false";

      const sheet = await parseOr400(fastify, file);
      const result = await importClients(fastify, request.tenantId, sheet, mapping, skipDuplicates);
      if (result.created > 0) {
        invalidateReadiness(request.tenantId);
        await invalidateDashboardCache(request.tenantId);
      }
      return result;
    },
  );

  fastify.get("/", async (request) => {
    const query = listQuerySchema.parse(request.query);
    const { status, type } = request.query as Record<string, string>;
    return clientsService.list(fastify, request.tenantId, { ...query, status, type });
  });

  fastify.get("/stats", async (request) => {
    return clientsService.stats(fastify, request.tenantId);
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

  // === Address standalone endpoints ===

  fastify.post<{ Params: { id: string } }>(
    "/:id/addresses",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request, reply) => {
      const body = clientAddressInputSchema.parse(request.body);
      const addr = await clientsService.addAddress(
        fastify,
        request.tenantId,
        request.params.id,
        body
      );
      return reply.status(201).send(addr);
    }
  );

  fastify.patch<{ Params: { id: string; addressId: string } }>(
    "/:id/addresses/:addressId",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      const body = clientAddressInputSchema.partial().parse(request.body);
      return clientsService.updateAddress(
        fastify,
        request.tenantId,
        request.params.id,
        request.params.addressId,
        body
      );
    }
  );

  fastify.delete<{ Params: { id: string; addressId: string } }>(
    "/:id/addresses/:addressId",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      return clientsService.removeAddress(
        fastify,
        request.tenantId,
        request.params.id,
        request.params.addressId
      );
    }
  );

  // === Equipment standalone endpoints ===

  fastify.get<{ Params: { id: string } }>(
    "/:id/equipment",
    async (request) => {
      const client = await fastify.prisma.client.findFirst({
        where: { id: request.params.id, tenantId: request.tenantId },
      });
      if (!client) throw fastify.httpErrors.notFound("Client not found");
      return fastify.prisma.equipment.findMany({
        where: { clientId: client.id },
        orderBy: { createdAt: "asc" },
        take: 200,
      });
    }
  );

  fastify.post<{ Params: { id: string } }>(
    "/:id/equipment",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request, reply) => {
      const body = equipmentInputSchema.parse(request.body);
      const eq = await clientsService.addEquipment(
        fastify,
        request.tenantId,
        request.params.id,
        body
      );
      return reply.status(201).send(eq);
    }
  );

  fastify.patch<{ Params: { id: string; equipmentId: string } }>(
    "/:id/equipment/:equipmentId",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      const body = equipmentInputSchema.partial().parse(request.body);
      return clientsService.updateEquipment(
        fastify,
        request.tenantId,
        request.params.id,
        request.params.equipmentId,
        body
      );
    }
  );

  fastify.delete<{ Params: { id: string; equipmentId: string } }>(
    "/:id/equipment/:equipmentId",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      return clientsService.removeEquipment(
        fastify,
        request.tenantId,
        request.params.id,
        request.params.equipmentId
      );
    }
  );

  // === Gas installation endpoints (instalații de utilizare) ===

  fastify.get<{ Params: { id: string } }>(
    "/:id/installations",
    async (request) => {
      return clientsService.listInstallations(fastify, request.tenantId, request.params.id);
    }
  );

  fastify.post<{ Params: { id: string } }>(
    "/:id/installations",
    { onRequest: [requireRole("ADMIN", "MANAGER", "OPERATOR")] },
    async (request, reply) => {
      const body = gasInstallationInputSchema.parse(request.body);
      const inst = await clientsService.addInstallation(
        fastify,
        request.tenantId,
        request.params.id,
        body
      );
      return reply.status(201).send(inst);
    }
  );

  fastify.patch<{ Params: { id: string; installationId: string } }>(
    "/:id/installations/:installationId",
    { onRequest: [requireRole("ADMIN", "MANAGER", "OPERATOR")] },
    async (request) => {
      const body = gasInstallationInputSchema.partial().parse(request.body);
      return clientsService.updateInstallation(
        fastify,
        request.tenantId,
        request.params.id,
        request.params.installationId,
        body
      );
    }
  );

  // === Quick-dossier endpoints (client-level rapid generation) ===
  // Backed by hidden Project rows (kind="quick_dossier") — see clients.service
  // for the rationale. Anything that touches the project list is filtered to
  // kind="project" so these stay scoped to the client detail page.

  fastify.get<{ Params: { id: string } }>(
    "/:id/dossiers",
    async (request) => {
      return clientsService.listDossiers(fastify, request.tenantId, request.params.id);
    }
  );

  fastify.post<{ Params: { id: string } }>(
    "/:id/dossiers",
    { onRequest: [requireRole("ADMIN", "MANAGER", "OPERATOR")], preHandler: [requireFeature("documents.dossiers")] },
    async (request, reply) => {
      const body = quickDossierInputSchema.parse(request.body);
      const d = await clientsService.createDossier(
        fastify,
        request.tenantId,
        request.user.sub,
        request.params.id,
        body,
      );
      return reply.status(201).send(d);
    }
  );

  fastify.patch<{ Params: { id: string; dossierId: string } }>(
    "/:id/dossiers/:dossierId",
    { onRequest: [requireRole("ADMIN", "MANAGER", "OPERATOR")], preHandler: [requireFeature("documents.dossiers")] },
    async (request) => {
      const body = updateQuickDossierSchema.parse(request.body);
      return clientsService.updateDossier(
        fastify,
        request.tenantId,
        request.params.id,
        request.params.dossierId,
        body,
      );
    }
  );

  fastify.post<{ Params: { id: string; dossierId: string } }>(
    "/:id/dossiers/:dossierId/generate",
    { onRequest: [requireRole("ADMIN", "MANAGER", "OPERATOR")], preHandler: [requireFeature("documents.dossiers")] },
    async (request, reply) => {
      const docs = await clientsService.generateDossier(
        fastify,
        request.tenantId,
        request.user.sub,
        request.params.id,
        request.params.dossierId,
      );
      return reply.status(202).send({ documents: docs });
    }
  );

  fastify.delete<{ Params: { id: string; dossierId: string } }>(
    "/:id/dossiers/:dossierId",
    { onRequest: [requireRole("ADMIN", "MANAGER") ] },
    async (request) => {
      return clientsService.removeDossier(
        fastify,
        request.tenantId,
        request.params.id,
        request.params.dossierId,
      );
    }
  );
}
