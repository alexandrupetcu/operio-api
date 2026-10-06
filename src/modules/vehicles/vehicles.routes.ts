import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import { paginationSchema } from "../../lib/pagination.js";
import { z } from "zod";
import * as vehiclesService from "./vehicles.service.js";
import { uploadFile, getPresignedUrl, deleteFile } from "../../lib/s3.js";

const createSchema = z.object({
  licensePlate: z.string().min(1).max(20),
  make: z.string().min(1).max(50),
  model: z.string().min(1).max(50),
  year: z.number().int().min(1900).max(2100).optional().nullable(),
  vin: z.string().max(17).optional().nullable(),
  fuelType: z.string().max(30).optional().nullable(),
  avgKmPerMonth: z.number().int().min(0).optional().nullable(),
  itpExpiry: z.string().datetime().optional().nullable(),
  insuranceExpiry: z.string().datetime().optional().nullable(),
  vignetteExpiry: z.string().datetime().optional().nullable(),
});

const updateSchema = createSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export type CreateVehicleInput = z.infer<typeof createSchema>;
export type UpdateVehicleInput = z.infer<typeof updateSchema>;

export default async function vehiclesRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async (request) => {
    const query = paginationSchema.parse(request.query);
    const { isActive, expiry } = request.query as Record<string, string>;
    return vehiclesService.list(fastify, request.tenantId, {
      ...query,
      isActive: isActive === undefined ? undefined : isActive === "true",
      expiry: expiry === "expired" || expiry === "soon" ? expiry : undefined,
    });
  });

  fastify.get("/stats", async (request) => {
    return vehiclesService.stats(fastify, request.tenantId);
  });

  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    return vehiclesService.getById(fastify, request.tenantId, request.params.id);
  });

  fastify.post("/", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request, reply) => {
      const body = createSchema.parse(request.body);
      const vehicle = await vehiclesService.create(fastify, request.tenantId, body);
      return reply.status(201).send(vehicle);
    },
  });

  fastify.patch<{ Params: { id: string } }>("/:id", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request) => {
      const body = updateSchema.parse(request.body);
      return vehiclesService.update(fastify, request.tenantId, request.params.id, body);
    },
  });

  fastify.delete<{ Params: { id: string } }>("/:id", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request) => {
      return vehiclesService.remove(fastify, request.tenantId, request.params.id);
    },
  });

  // ── Vehicle Revisions ──

  // List revisions for a vehicle
  fastify.get<{ Params: { id: string } }>(
    "/:id/revisions",
    async (request) => {
      await vehiclesService.getById(fastify, request.tenantId, request.params.id);
      return fastify.prisma.vehicleRevision.findMany({
        where: { vehicleId: request.params.id },
        orderBy: { date: "desc" },
      });
    }
  );

  // Add revision
  const revisionSchema = z.object({
    date: z.string().datetime({ offset: true }).or(z.string().min(10)),
    km: z.number().int().min(0),
    notes: z.string().max(500).optional().nullable(),
  });

  fastify.post<{ Params: { id: string } }>("/:id/revisions", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request, reply) => {
      await vehiclesService.getById(fastify, request.tenantId, request.params.id);
      const body = revisionSchema.parse(request.body);
      const revision = await fastify.prisma.vehicleRevision.create({
        data: {
          vehicleId: request.params.id,
          date: new Date(body.date),
          km: body.km,
          notes: body.notes ?? null,
        },
      });
      return reply.status(201).send(revision);
    },
  });

  // Delete revision
  fastify.delete<{ Params: { id: string; revisionId: string } }>(
    "/:id/revisions/:revisionId",
    {
      onRequest: [requireRole("ADMIN", "MANAGER")],
      handler: async (request) => {
        await vehiclesService.getById(fastify, request.tenantId, request.params.id);
        return fastify.prisma.vehicleRevision.delete({
          where: { id: request.params.revisionId },
        });
      },
    }
  );

  // Upload document (talon, civ, rca, vignette)
  const VALID_DOC_TYPES = ["talon", "civ", "rca", "vignette"] as const;
  const S3_KEY_MAP: Record<string, string> = {
    talon: "talonS3Key",
    civ: "civS3Key",
    rca: "rcaS3Key",
    vignette: "vignetteS3Key",
  };

  fastify.post<{ Params: { id: string; docType: string } }>(
    "/:id/documents/:docType",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request, reply) => {
      const { id, docType } = request.params;
      if (!VALID_DOC_TYPES.includes(docType as any)) {
        throw fastify.httpErrors.badRequest(`Invalid document type. Must be one of: ${VALID_DOC_TYPES.join(", ")}`);
      }

      const vehicle = await vehiclesService.getById(fastify, request.tenantId, id);
      const file = await request.file();
      if (!file) throw fastify.httpErrors.badRequest("File is required");

      const buffer = await file.toBuffer();
      // Constrain extension to a safe alphanumeric tail — user-supplied
      // filenames can carry path separators, null bytes, or weird unicode.
      const rawExt = (file.filename.split(".").pop() ?? "pdf").toLowerCase();
      const ext = rawExt.replace(/[^a-z0-9]/g, "").slice(0, 8) || "pdf";
      const s3Key = `${request.tenantId}/vehicles/${id}/${docType}.${ext}`;

      // Delete old file if exists
      const oldKey = (vehicle as any)[S3_KEY_MAP[docType]];
      if (oldKey) await deleteFile(oldKey).catch(() => {});

      await uploadFile(s3Key, buffer, file.mimetype);

      const updated = await fastify.prisma.vehicle.update({
        where: { id },
        data: { [S3_KEY_MAP[docType]]: s3Key },
      });

      return reply.send(updated);
    }
  );

  // Download document
  fastify.get<{ Params: { id: string; docType: string } }>(
    "/:id/documents/:docType/download",
    async (request) => {
      const { id, docType } = request.params;
      if (!VALID_DOC_TYPES.includes(docType as any)) {
        throw fastify.httpErrors.badRequest("Invalid document type");
      }

      const vehicle = await vehiclesService.getById(fastify, request.tenantId, id);
      const s3Key = (vehicle as any)[S3_KEY_MAP[docType]];
      if (!s3Key) throw fastify.httpErrors.notFound("Document not found");

      const url = await getPresignedUrl(s3Key);
      return { url };
    }
  );

  // Delete document
  fastify.delete<{ Params: { id: string; docType: string } }>(
    "/:id/documents/:docType",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      const { id, docType } = request.params;
      if (!VALID_DOC_TYPES.includes(docType as any)) {
        throw fastify.httpErrors.badRequest("Invalid document type");
      }

      const vehicle = await vehiclesService.getById(fastify, request.tenantId, id);
      const s3Key = (vehicle as any)[S3_KEY_MAP[docType]];
      if (s3Key) await deleteFile(s3Key).catch(() => {});

      return fastify.prisma.vehicle.update({
        where: { id },
        data: { [S3_KEY_MAP[docType]]: null },
      });
    }
  );
}
