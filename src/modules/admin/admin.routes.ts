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
    return fastify.prisma.tenant.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        emailIngestionEnabled: true,
      },
      orderBy: { name: "asc" },
      take: 500,
    });
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
