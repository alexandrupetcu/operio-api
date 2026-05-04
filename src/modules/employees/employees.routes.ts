import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import { paginationSchema } from "../../lib/pagination.js";
import { z } from "zod";
import * as employeesService from "./employees.service.js";

const createSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  employeeType: z.enum(["intern", "colaborator"]).default("intern"),
  position: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().max(100).optional().nullable(),
  ),
  phone: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().max(30).optional().nullable(),
  ),
  email: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().email().optional().nullable(),
  ),
  credentials: z.record(z.string()).optional(),
});

const updateSchema = createSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export type CreateEmployeeInput = z.infer<typeof createSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateSchema>;

export default async function employeesRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async (request) => {
    const query = paginationSchema.parse(request.query);
    return employeesService.list(fastify, request.tenantId, query);
  });

  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    return employeesService.getById(fastify, request.tenantId, request.params.id);
  });

  fastify.post("/", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request, reply) => {
      const body = createSchema.parse(request.body);
      const employee = await employeesService.create(fastify, request.tenantId, body);
      return reply.status(201).send(employee);
    },
  });

  fastify.patch<{ Params: { id: string } }>("/:id", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request) => {
      const body = updateSchema.parse(request.body);
      return employeesService.update(fastify, request.tenantId, request.params.id, body);
    },
  });

  fastify.delete<{ Params: { id: string } }>("/:id", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request) => {
      return employeesService.remove(fastify, request.tenantId, request.params.id);
    },
  });
}
