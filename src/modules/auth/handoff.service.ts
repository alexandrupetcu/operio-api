import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { appUrlFor } from "../../lib/tenant-subdomain.js";
import { hashRefreshToken, issueTokens } from "./auth.service.js";

/**
 * Mutarea sesiunii web pe adresa firmei. Sesiunea stă în localStorage-ul fiecărei adrese,
 * deci un om autentificat pe `app.operio.ro` (sau pe subdomeniul altei firme) nu poate fi
 * doar redirecționat: primește un cod de unică folosință, valabil 60 s, pe care aplicația
 * de pe adresa corectă îl schimbă pe o sesiune nouă. Sesiunea de pe adresa veche se închide.
 */
const HANDOFF_TTL_MS = 60 * 1000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function startHandoff(
  fastify: FastifyInstance,
  userId: string,
  refreshToken: string | null,
  cfg: { baseDomain: string | undefined; frontendUrl: string },
) {
  const user = await fastify.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, tenant: { select: { subdomain: true } } } });
  const targetUrl = appUrlFor(user.tenant?.subdomain, cfg.baseDomain, cfg.frontendUrl);
  if (refreshToken) {
    await fastify.prisma.refreshToken.deleteMany({ where: { userId, token: hashRefreshToken(refreshToken) } });
  }
  const raw = randomBytes(32).toString("hex");
  await fastify.prisma.sessionHandoff.create({
    data: { userId, tokenHash: sha256(raw), targetUrl, expiresAt: new Date(Date.now() + HANDOFF_TTL_MS) },
  });
  return { url: `${targetUrl}/auth/handoff?code=${raw}`, targetUrl };
}

/** Schimbă codul pe o sesiune web — o singură dată, înainte să expire, doar pe adresa pentru care a fost emis. */
export async function exchangeHandoff(fastify: FastifyInstance, code: string, origin: string | undefined) {
  const expired = () => fastify.httpErrors.unauthorized("Linkul de autentificare a expirat — autentifică-te din nou");
  const found = await fastify.prisma.sessionHandoff.findUnique({ where: { tokenHash: sha256(code) } });
  if (!found || found.usedAt || found.expiresAt.getTime() < Date.now()) throw expired();
  if (origin && origin.replace(/\/$/, "") !== found.targetUrl) {
    throw fastify.httpErrors.badRequest("Linkul este pentru altă adresă a aplicației");
  }
  // Marcat folosit atomic: două cereri cu același cod nu pot lua amândouă sesiune.
  const { count } = await fastify.prisma.sessionHandoff.updateMany({ where: { id: found.id, usedAt: null }, data: { usedAt: new Date() } });
  if (count !== 1) throw expired();

  const user = await fastify.prisma.user.findUnique({
    where: { id: found.userId },
    include: { tenant: { include: { country: { select: { id: true, name: true, emoji: true } } } } },
  });
  if (!user || !user.isActive) throw expired();
  const tokens = await issueTokens(fastify, { id: user.id, tenantId: user.tenantId, role: user.role }, { client: "web" });
  const t = user.tenant;
  return {
    ...tokens,
    user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, role: user.role, mobileAccess: user.mobileAccess },
    tenant: t ? { id: t.id, name: t.name, slug: t.slug, subdomain: t.subdomain, countryId: t.countryId, country: t.country } : null,
  };
}
