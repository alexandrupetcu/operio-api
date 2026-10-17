import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { requireRole } from "../../lib/rbac.js";
import { getAuthUrl, exchangeCode } from "../../lib/gmail.js";
import { redisConnection } from "../../config/redis.js";
import { defaultJobOptions } from "../../config/queue.js";

const emailQueue = new Queue("email-ingestion", { connection: redisConnection, defaultJobOptions });

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
  // Opaque nonce returned by GET /auth-url (echoed back by Google as `state`).
  state: z.string().min(1).max(128),
  redirectUri: z.string().url().optional(),
});

// ── OAuth state (CSRF nonce) ─────────────────────────────────────────
// GET /auth-url mints a random `state`, binds it to {inbox, tenant, user,
// redirectUri} in Redis for 10 minutes; the callback must present the same
// state, and only the user who started the flow may finish it.
const OAUTH_STATE_TTL_SECONDS = 600;
const oauthStateKey = (state: string) => `oauth:gmail:${state}`;

interface OAuthStateEntry {
  inboxId: string;
  tenantId: string | null;
  userId: string;
  redirectUri?: string;
  exp: number;
}

let redis: Redis | null = null;
function redisClient(): Redis {
  if (!redis) redis = new Redis({ ...redisConnection, lazyConnect: true, enableOfflineQueue: false });
  return redis;
}

async function storeOAuthState(entry: OAuthStateEntry): Promise<string> {
  const state = randomBytes(32).toString("base64url");
  await redisClient().set(oauthStateKey(state), JSON.stringify(entry), "EX", OAUTH_STATE_TTL_SECONDS);
  return state;
}

/** Load + delete (single use). Returns null when unknown/expired. */
async function consumeOAuthState(state: string): Promise<OAuthStateEntry | null> {
  const key = oauthStateKey(state);
  const raw = await redisClient().getdel(key);
  if (!raw) return null;
  try {
    const entry = JSON.parse(raw) as OAuthStateEntry;
    if (typeof entry.exp !== "number" || entry.exp < Date.now()) return null;
    return entry;
  } catch {
    return null;
  }
}

/** Inbox-urile pe care utilizatorul le poate modifica: ale tenantului său; cele globale doar MASTER_ADMIN. */
function ownedInboxWhere(request: { params: { id: string }; tenantId: string; user?: { role?: string } }) {
  return request.user?.role === "MASTER_ADMIN"
    ? { id: request.params.id }
    : { id: request.params.id, tenantId: request.tenantId };
}

export default async function emailInboxesRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  // List inboxes (tenant-specific + global)
  fastify.get(
    "/",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      // Token-urile OAuth nu părăsesc niciodată serverul — expunem doar dacă inbox-ul e autorizat.
      const rows = await fastify.prisma.emailInbox.findMany({
        where: request.user?.role === "MASTER_ADMIN" ? {} : { OR: [{ tenantId: request.tenantId }, { tenantId: null }] },
        orderBy: { createdAt: "asc" },
        omit: { refreshToken: true, accessToken: true },
        take: 200,
      });
      return rows;
    }
  );

  // Create inbox
  fastify.post(
    "/",
    { onRequest: [requireRole("ADMIN")] },
    async (request, reply) => {
      const body = createSchema.parse(request.body);
      // Doar administratorul platformei poate crea inbox-uri globale sau pentru alt tenant.
      const tenantId = request.user?.role === "MASTER_ADMIN" ? (body.tenantId ?? null) : request.tenantId;
      const inbox = await fastify.prisma.emailInbox.create({
        data: {
          tenantId,
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
        where: ownedInboxWhere(request),
      });
      if (!inbox) throw fastify.httpErrors.notFound("Inbox not found");

      return fastify.prisma.emailInbox.update({
        where: { id: inbox.id },
        data: body,
        omit: { refreshToken: true, accessToken: true },
      });
    }
  );

  // Delete inbox
  fastify.delete<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      const inbox = await fastify.prisma.emailInbox.findFirst({
        where: ownedInboxWhere(request),
      });
      if (!inbox) throw fastify.httpErrors.notFound("Inbox not found");

      return fastify.prisma.emailInbox.delete({ where: { id: inbox.id } });
    }
  );

  // Get OAuth2 authorization URL. Mints a single-use `state` nonce bound to
  // the caller + inbox (Redis, 10 min). Response: { url }.
  fastify.get<{ Querystring: { redirectUri?: string; inboxId?: string } }>(
    "/auth-url",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      const { redirectUri, inboxId } = z
        .object({ inboxId: z.string().min(1), redirectUri: z.string().url().optional() })
        .parse(request.query);

      // The inbox must exist and be one the caller may manage.
      const inbox = await fastify.prisma.emailInbox.findFirst({
        where: ownedInboxWhere({ params: { id: inboxId }, tenantId: request.tenantId, user: request.user }),
        select: { id: true },
      });
      if (!inbox) throw fastify.httpErrors.notFound("Inbox not found");

      const state = await storeOAuthState({
        inboxId: inbox.id,
        tenantId: request.user.tenantId ?? null,
        userId: request.user.sub,
        redirectUri,
        exp: Date.now() + OAUTH_STATE_TTL_SECONDS * 1000,
      });
      const url = getAuthUrl(redirectUri, state);
      return { url };
    }
  );

  /**
   * Validate the `state` nonce against the caller and (optionally) a URL
   * inbox id, exchange the code and store the tokens on the inbox.
   */
  async function finishAuthorization(
    request: { tenantId: string; user: { sub: string; tenantId: string | null; role?: string } },
    body: z.infer<typeof authorizeSchema>,
    expectedInboxId?: string
  ) {
    const entry = await consumeOAuthState(body.state);
    if (!entry) throw fastify.httpErrors.badRequest("Sesiunea de autorizare a expirat sau este invalidă. Reluați autorizarea.");
    if (entry.userId !== request.user.sub || entry.tenantId !== (request.user.tenantId ?? null)) {
      throw fastify.httpErrors.forbidden("Autorizarea a fost inițiată de alt utilizator");
    }
    if (expectedInboxId && expectedInboxId !== entry.inboxId) {
      throw fastify.httpErrors.badRequest("state nu corespunde inbox-ului");
    }

    const inbox = await fastify.prisma.emailInbox.findFirst({
      where: ownedInboxWhere({ params: { id: entry.inboxId }, tenantId: request.tenantId, user: request.user }),
    });
    if (!inbox) throw fastify.httpErrors.notFound("Inbox not found");

    // The redirect URI must match the one used for the consent URL.
    const tokens = await exchangeCode(body.code, entry.redirectUri ?? body.redirectUri);

    return fastify.prisma.emailInbox.update({
      where: { id: inbox.id },
      data: {
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        tokenExpiresAt: tokens.expiresAt,
      },
      omit: { refreshToken: true, accessToken: true },
    });
  }

  // Exchange authorization code for tokens. Body: { code, state, redirectUri? }
  // — the inbox is resolved from `state`.
  fastify.post(
    "/authorize",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      const body = authorizeSchema.parse(request.body);
      return finishAuthorization(request, body);
    }
  );

  // DEPRECATED (kept one release for the UI migration): same as POST /authorize
  // but with the inbox id in the URL; `state` is required and must match it.
  fastify.post<{ Params: { id: string } }>(
    "/:id/authorize",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      const body = authorizeSchema.parse(request.body);
      return finishAuthorization(request, body, request.params.id);
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
