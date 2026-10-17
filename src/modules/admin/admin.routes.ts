import { Prisma } from "@prisma/client";
import { PLANS, FEATURES, entitlementOverridesSchema, resolveEntitlements, serializeEntitlements, invalidateEntitlements } from "../../lib/entitlements/index.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireMasterAdmin } from "../../lib/rbac.js";
import * as adminService from "./admin.service.js";
import emailLogsRoutes from "./email-logs.routes.js";

const listDocumentsQuerySchema = z.object({
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});

export default async function adminRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);
  // Vedere peste toți tenanții — strict pentru administratorul platformei.
  fastify.addHook("onRequest", requireMasterAdmin());

  // Queue statistics
  fastify.get("/queue-stats", async () => {
    return adminService.getQueueStats();
  });

  // List all documents across tenants
  fastify.get("/documents", async (request) => {
    const { status, page, limit } = listDocumentsQuerySchema.parse(request.query);
    return adminService.listAllDocuments(fastify, { status, page, limit });
  });

  // Retry a failed document
  fastify.post<{ Params: { id: string } }>(
    "/documents/:id/retry",
    async (request) => {
      return adminService.retryDocument(fastify, request.params.id);
    }
  );

  // List all tenants (for integrations UI)
  fastify.get("/tenants", async () => {
    const [tenants, mobile] = await Promise.all([
      fastify.prisma.tenant.findMany({
        select: {
          id: true, name: true, slug: true, cui: true, emailIngestionEnabled: true,
          plan: true, planUntil: true, entitlementOverrides: true, createdAt: true,
          _count: { select: { users: true } },
        },
        orderBy: { name: "asc" },
        take: 500,
      }),
      fastify.prisma.user.groupBy({ by: ["tenantId"], where: { mobileAccess: true, isActive: true }, _count: { _all: true } }),
    ]);
    const mobileByTenant = new Map(mobile.map((m) => [m.tenantId, m._count._all]));
    return tenants.map(({ _count, ...t }) => ({
      ...t,
      usersCount: _count.users,
      mobileUsersCount: mobileByTenant.get(t.id) ?? 0,
      entitlements: serializeEntitlements(resolveEntitlements(t)),
    }));
  });

  // Catalogul de planuri și funcții (din cod) — pentru ecranul de abonamente.
  fastify.get("/plans", async () => ({ plans: PLANS, features: FEATURES }));

  // Abonamentul unei firme: plan, valabilitate, ajustări (pilot, add-on, preț de fondator).
  fastify.patch<{ Params: { id: string } }>("/tenants/:id/plan", async (request) => {
    const body = z
      .object({
        plan: z.enum(["field", "execution"]).optional(),
        planUntil: z.string().datetime().nullable().optional(),
        entitlementOverrides: entitlementOverridesSchema.nullable().optional(),
      })
      .parse(request.body);
    const tenant = await fastify.prisma.tenant.update({
      where: { id: request.params.id },
      data: {
        ...(body.plan !== undefined && { plan: body.plan }),
        ...(body.planUntil !== undefined && { planUntil: body.planUntil ? new Date(body.planUntil) : null }),
        ...(body.entitlementOverrides !== undefined && {
          entitlementOverrides: body.entitlementOverrides === null ? Prisma.DbNull : (body.entitlementOverrides as Prisma.InputJsonValue),
        }),
      },
      select: { id: true, name: true, plan: true, planUntil: true, entitlementOverrides: true },
    });
    invalidateEntitlements(tenant.id);
    return { ...tenant, entitlements: serializeEntitlements(resolveEntitlements(tenant)) };
  });

  // Toggle email ingestion for a specific tenant
  fastify.patch<{ Params: { id: string } }>(
    "/tenants/:id/email-ingestion",
    async (request) => {
      const body = request.body as { enabled: boolean };
      return fastify.prisma.tenant.update({
        where: { id: request.params.id },
        data: { emailIngestionEnabled: body.enabled },
        select: { id: true, name: true, emailIngestionEnabled: true },
      });
    }
  );

  // Email ingest logs (reconciliation)
  await fastify.register(emailLogsRoutes, { prefix: "/email-logs" });
}
