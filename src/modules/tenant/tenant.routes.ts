import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import { z } from "zod";

const updateTenantSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  address: z.string().max(200).optional().nullable(),
  phone: z.string().max(30).optional().nullable(),
  email: z.string().email().max(100).optional().nullable(),
  cui: z.string().max(20).optional().nullable(),
  regCom: z.string().max(30).optional().nullable(),
  countryId: z.number().int().positive().optional().nullable(),
  stateId: z.number().int().positive().optional().nullable(),
  cityId: z.number().int().positive().optional().nullable(),
});

export default async function tenantRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async (request) => {
    return fastify.prisma.tenant.findUniqueOrThrow({
      where: { id: request.tenantId },
      include: {
        country: { select: { id: true, name: true, emoji: true } },
        state: { select: { id: true, name: true } },
        city: { select: { id: true, name: true } },
      },
    });
  });

  fastify.patch("/", {
    onRequest: [requireRole("ADMIN")],
    handler: async (request) => {
      const body = updateTenantSchema.parse(request.body);
      return fastify.prisma.tenant.update({
        where: { id: request.tenantId },
        data: body,
        include: {
          country: { select: { id: true, name: true, emoji: true } },
          state: { select: { id: true, name: true } },
          city: { select: { id: true, name: true } },
        },
      });
    },
  });
}
