import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import { paginationSchema } from "../../lib/pagination.js";
import { z } from "zod";
import * as employeesService from "./employees.service.js";
import { getSchedulingSettings } from "../tenant/scheduling-settings.js";

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
    const { isActive, employeeType } = request.query as Record<string, string>;
    // În modul cu calendare separate, un tehnician nu are de ce să vadă echipa:
    // pe telefon nu mai alege tehnicianul, iar ocuparea colegilor e informație
    // despre programul lor. Primește doar propria fișă.
    let onlyUserId: string | undefined;
    if (request.user?.role === "OPERATOR") {
      const scheduling = await getSchedulingSettings(fastify.prisma, request.tenantId);
      if (scheduling.mode === "per_technician") onlyUserId = request.user.sub;
    }
    return employeesService.list(fastify, request.tenantId, {
      ...query,
      isActive: isActive === undefined ? undefined : isActive === "true",
      employeeType: employeeType || undefined,
      onlyUserId,
    });
  });

  fastify.get("/stats", async (request) => {
    return employeesService.stats(fastify, request.tenantId);
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

  // Save signature drawn on the canvas (PNG data URL) — placed on generated
  // documents as {role}_signature.
  fastify.post<{ Params: { id: string } }>("/:id/signature", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request, reply) => {
      const { dataUrl } = z.object({ dataUrl: z.string().min(1) }).parse(request.body);
      const result = await employeesService.setSignature(
        fastify,
        request.tenantId,
        request.params.id,
        dataUrl,
      );
      return reply.send(result);
    },
  });

  fastify.delete<{ Params: { id: string } }>("/:id/signature", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request) => {
      return employeesService.removeSignature(fastify, request.tenantId, request.params.id);
    },
  });
}
