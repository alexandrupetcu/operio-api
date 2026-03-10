import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import { paginationSchema } from "../../lib/pagination.js";
import { z } from "zod";
import * as servicesService from "./services.service.js";

const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional().nullable(),
  unit: z.string().max(30).optional().nullable(),
  price: z.number().min(0).optional().nullable(),
});

const updateSchema = createSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export type CreateServiceInput = z.infer<typeof createSchema>;
export type UpdateServiceInput = z.infer<typeof updateSchema>;

export default async function servicesRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async (request) => {
    const query = paginationSchema.parse(request.query);
    return servicesService.list(fastify, request.tenantId, query);
  });

  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    return servicesService.getById(fastify, request.tenantId, request.params.id);
  });

  fastify.post("/", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request, reply) => {
      const body = createSchema.parse(request.body);
      const service = await servicesService.create(fastify, request.tenantId, body);
      return reply.status(201).send(service);
    },
  });

  fastify.patch<{ Params: { id: string } }>("/:id", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request) => {
      const body = updateSchema.parse(request.body);
      return servicesService.update(fastify, request.tenantId, request.params.id, body);
    },
  });

  fastify.delete<{ Params: { id: string } }>("/:id", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request) => {
      return servicesService.remove(fastify, request.tenantId, request.params.id);
    },
  });
}
