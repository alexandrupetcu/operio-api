import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../../lib/rbac.js";
import {
  createSeriesSchema,
  updateSeriesSchema,
  createEntrySchema,
  updateEntrySchema,
  voidEntrySchema,
} from "./registry.schema.js";
import * as registryService from "./registry.service.js";

const listEntriesQuerySchema = z.object({
  seriesId: z.string().optional(),
  year: z.coerce.number().int().optional(),
  search: z.string().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const statsQuerySchema = z.object({
  year: z.coerce.number().int().default(() => new Date().getFullYear()),
});

export default async function registryRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  // ─── Series ─────────────────────────────────────────────────────────

  fastify.get("/series", async (request) => {
    return registryService.listSeries(fastify, request.tenantId);
  });

  fastify.post(
    "/series",
    { onRequest: [requireRole("ADMIN")] },
    async (request, reply) => {
      const body = createSeriesSchema.parse(request.body);
      const series = await registryService.createSeries(
        fastify,
        request.tenantId,
        body
      );
      return reply.status(201).send(series);
    }
  );

  fastify.patch<{ Params: { id: string } }>(
    "/series/:id",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      const body = updateSeriesSchema.parse(request.body);
      return registryService.updateSeries(
        fastify,
        request.tenantId,
        request.params.id,
        body
      );
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    "/series/:id",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      return registryService.deleteSeries(
        fastify,
        request.tenantId,
        request.params.id
      );
    }
  );

  // ─── Entries ────────────────────────────────────────────────────────

  fastify.get("/entries", async (request) => {
    const q = listEntriesQuerySchema.parse(request.query);
    return registryService.listEntries(fastify, request.tenantId, {
      seriesId: q.seriesId,
      year: q.year,
      search: q.search,
      status: q.status,
      limit: q.limit,
      offset: q.offset,
    });
  });

  fastify.get("/stats", async (request) => {
    const { year } = statsQuerySchema.parse(request.query);
    return registryService.stats(fastify, request.tenantId, year);
  });

  fastify.get<{ Querystring: { seriesId: string } }>(
    "/entries/next-number",
    async (request) => {
      const { seriesId } = request.query;
      if (!seriesId) throw fastify.httpErrors.badRequest("seriesId required");
      return registryService.getNextNumberPreview(
        fastify,
        request.tenantId,
        seriesId
      );
    }
  );

  fastify.get<{ Params: { id: string } }>("/entries/:id", async (request) => {
    return registryService.getEntryById(
      fastify,
      request.tenantId,
      request.params.id
    );
  });

  fastify.post(
    "/entries",
    { onRequest: [requireRole("ADMIN", "MANAGER", "OPERATOR")] },
    async (request, reply) => {
      const body = createEntrySchema.parse(request.body);
      const isAdmin = request.user.role === "ADMIN" || request.user.role === "MASTER_ADMIN";
      const entry = await registryService.createEntry(
        fastify,
        request.tenantId,
        request.user.sub,
        body,
        isAdmin
      );
      return reply.status(201).send(entry);
    }
  );

  fastify.patch<{ Params: { id: string } }>(
    "/entries/:id",
    { onRequest: [requireRole("ADMIN", "MANAGER", "OPERATOR")] },
    async (request) => {
      const body = updateEntrySchema.parse(request.body);
      return registryService.updateEntry(
        fastify,
        request.tenantId,
        request.params.id,
        body
      );
    }
  );

  fastify.post<{ Params: { id: string } }>(
    "/entries/:id/void",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      const body = voidEntrySchema.parse(request.body);
      return registryService.voidEntry(
        fastify,
        request.tenantId,
        request.user.sub,
        request.params.id,
        body
      );
    }
  );
}
