import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Queue } from "bullmq";
import { requireRole } from "../../lib/rbac.js";
import { getAuthUrl, exchangeCode } from "../../lib/gmail.js";
import { redisConnection } from "../../config/redis.js";

const emailQueue = new Queue("email-ingestion", { connection: redisConnection });

const createSchema = z.object({
  label: z.string().min(1).max(100),
  email: z.string().email(),
  purpose: z.string().default("revision_import"),
  tenantId: z.string().cuid().optional().nullable(),
});

const updateSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  isActive: z.boolean().optional(),
  purpose: z.string().optional(),
});

const authorizeSchema = z.object({
  code: z.string().min(1),
  redirectUri: z.string().optional(),
});

export default async function emailInboxesRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  // List inboxes (tenant-specific + global)
  fastify.get(
    "/",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      return fastify.prisma.emailInbox.findMany({
        where: {
          OR: [
            { tenantId: request.tenantId },
            { tenantId: null },
          ],
        },
        orderBy: { createdAt: "asc" },
      });
    }
  );

  // Create inbox
  fastify.post(
    "/",
    { onRequest: [requireRole("ADMIN")] },
    async (request, reply) => {
      const body = createSchema.parse(request.body);
      const inbox = await fastify.prisma.emailInbox.create({
        data: {
          tenantId: body.tenantId ?? null,
          label: body.label,
          email: body.email,
          purpose: body.purpose,
        },
      });
      return reply.status(201).send(inbox);
    }
  );

  // Update inbox
  fastify.patch<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      const body = updateSchema.parse(request.body);
      const inbox = await fastify.prisma.emailInbox.findFirst({
        where: {
          id: request.params.id,
          OR: [{ tenantId: request.tenantId }, { tenantId: null }],
        },
      });
      if (!inbox) throw fastify.httpErrors.notFound("Inbox not found");

      return fastify.prisma.emailInbox.update({
        where: { id: inbox.id },
        data: body,
      });
    }
  );

  // Delete inbox
  fastify.delete<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      const inbox = await fastify.prisma.emailInbox.findFirst({
        where: {
          id: request.params.id,
          OR: [{ tenantId: request.tenantId }, { tenantId: null }],
        },
      });
      if (!inbox) throw fastify.httpErrors.notFound("Inbox not found");

      return fastify.prisma.emailInbox.delete({ where: { id: inbox.id } });
    }
  );

  // Get OAuth2 authorization URL
  fastify.get<{ Querystring: { redirectUri?: string; inboxId?: string } }>(
    "/auth-url",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      const { redirectUri, inboxId } = request.query as { redirectUri?: string; inboxId?: string };
      const url = getAuthUrl(redirectUri, inboxId);
      return { url };
    }
  );

  // Exchange authorization code for tokens on a specific inbox
  fastify.post<{ Params: { id: string } }>(
    "/:id/authorize",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      const body = authorizeSchema.parse(request.body);
      const inbox = await fastify.prisma.emailInbox.findFirst({
        where: {
          id: request.params.id,
          OR: [{ tenantId: request.tenantId }, { tenantId: null }],
        },
      });
      if (!inbox) throw fastify.httpErrors.notFound("Inbox not found");

      const tokens = await exchangeCode(body.code, body.redirectUri);

      return fastify.prisma.emailInbox.update({
        where: { id: inbox.id },
        data: {
          refreshToken: tokens.refreshToken,
          accessToken: tokens.accessToken,
          tokenExpiresAt: tokens.expiresAt,
        },
      });
    }
  );

  // Trigger immediate poll (manual "check now")
  fastify.post(
    "/poll-now",
    { onRequest: [requireRole("ADMIN")] },
    async () => {
      await emailQueue.add("poll-inbox", {});
      return { ok: true };
    }
  );

  // Toggle email ingestion for tenant
  fastify.patch(
    "/tenant-toggle",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      const body = z.object({ enabled: z.boolean() }).parse(request.body);
      return fastify.prisma.tenant.update({
        where: { id: request.tenantId },
        data: { emailIngestionEnabled: body.enabled },
      });
    }
  );
}
