import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { verifyPassword } from "../../lib/hash.js";
import { logAudit } from "../../lib/audit.js";

/**
 * Impersonarea unei firme de către administratorul platformei (MASTER_ADMIN),
 * DOAR CITIRE: după reconfirmarea propriei parole primește un token de acces
 * (fără refresh) de 60 de minute, cu `role: ADMIN` și `tenantId` = firma, plus
 * `imp: { by, readOnly: true }`. Garda de mai jos respinge orice scriere făcută
 * cu un astfel de token; intrarea și ieșirea apar în auditul firmei.
 */

export const IMPERSONATION_TTL_MIN = 60;
export const READ_ONLY_MESSAGE = "Mod doar citire: vizualizezi firma ca administrator al platformei.";

/** Rutele care scriu, dar sunt permise în modul doar citire (ieșirea din sesiune). */
const WRITE_ALLOWLIST = new Set(["/api/admin/impersonation/end", "/api/auth/logout"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function startImpersonation(
  fastify: FastifyInstance,
  masterUserId: string,
  tenantId: string,
  password: string,
) {
  const master = await fastify.prisma.user.findUnique({
    where: { id: masterUserId },
    select: { id: true, role: true, isActive: true, passwordHash: true },
  });
  if (!master || master.role !== "MASTER_ADMIN" || !master.isActive) {
    throw fastify.httpErrors.forbidden("Master admin access required");
  }
  const ok = await verifyPassword(master.passwordHash, password).catch(() => false);
  if (!ok) throw fastify.httpErrors.unauthorized("Parola nu este corectă");

  const tenant = await fastify.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } });
  if (!tenant) throw fastify.httpErrors.notFound("Firma nu există");

  const accessToken = fastify.jwt.sign(
    {
      sub: master.id,
      tenantId: tenant.id,
      role: "ADMIN",
      client: "web",
      imp: { by: master.id, readOnly: true },
    },
    { expiresIn: `${IMPERSONATION_TTL_MIN}m` },
  );
  const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_MIN * 60_000).toISOString();
  await logAudit(fastify, tenant.id, master.id, "tenant", tenant.id, "impersonate_start", undefined, { readOnly: true });
  return { accessToken, expiresAt, tenant };
}

export async function endImpersonation(fastify: FastifyInstance, request: FastifyRequest) {
  const imp = request.user?.imp;
  if (!imp || !request.user.tenantId) throw fastify.httpErrors.badRequest("Nu există o sesiune de impersonare");
  await logAudit(fastify, request.user.tenantId, imp.by, "tenant", request.user.tenantId, "impersonate_end");
}

/** Decizia gărzii, separată ca să fie testabilă fără un server. */
export function isBlockedWrite(method: string, path: string, readOnly: boolean | undefined): boolean {
  if (!readOnly) return false;
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  return !WRITE_ALLOWLIST.has(path.split("?")[0]);
}

/**
 * Garda globală: rulează ca `preHandler`, adică după hook-urile `onRequest` ale
 * rutelor (unde `authenticate` pune `request.user`), înaintea handler-ului.
 */
export const readOnlyGuardPlugin = fp(async (fastify: FastifyInstance) => {
  fastify.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (isBlockedWrite(request.method, request.url, request.user?.imp?.readOnly)) {
      return reply.code(403).send({ statusCode: 403, error: "Forbidden", message: READ_ONLY_MESSAGE });
    }
  });
});

/** `POST /api/admin/impersonation/end` — în afara gărzii master (tokenul are rol ADMIN). */
export async function impersonationRoutes(fastify: FastifyInstance) {
  fastify.post("/end", { onRequest: [fastify.authenticate] }, async (request, reply) => {
    await endImpersonation(fastify, request);
    return reply.code(204).send();
  });
}
