import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import { paginationSchema } from "../../lib/pagination.js";
import { z } from "zod";
import * as vehiclesService from "./vehicles.service.js";

const createSchema = z.object({
  licensePlate: z.string().min(1).max(20),
  make: z.string().min(1).max(50),
  model: z.string().min(1).max(50),
  year: z.number().int().min(1900).max(2100).optional().nullable(),
  vin: z.string().max(17).optional().nullable(),
  fuelType: z.string().max(30).optional().nullable(),
  insuranceExpiry: z.string().datetime().optional().nullable(),
  itpExpiry: z.string().datetime().optional().nullable(),
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
    return vehiclesService.list(fastify, request.tenantId, query);
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
}
