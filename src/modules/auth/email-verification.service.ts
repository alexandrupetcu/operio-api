import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { env } from "../../config/env.js";
import { sendEmailVerificationEmail } from "../../lib/email.js";
import { appUrlFor } from "../../lib/tenant-subdomain.js";

/**
 * Confirmarea adresei de e-mail pentru conturile din înregistrarea publică. Contul se
 * poate folosi imediat; până la confirmare nu poate invita colegi, nu primește
 * notificări pe e-mail și nu poate alege codurile 2FA pe e-mail.
 *
 * Același tipar ca la resetarea parolei / mutarea sesiunii: token aleator de 32 de
 * octeți, în bază doar SHA-256, de unică folosință (consum atomic), valabil 48 h.
 * Invitația și resetarea parolei prin link dovedesc și ele adresa (vezi resetPassword).
 */
const VERIFY_TTL_MS = 48 * 60 * 60 * 1000;

export const EMAIL_NOT_VERIFIED_INVITE = "Confirmă-ți adresa de e-mail înainte să inviți colegi.";
export const EMAIL_NOT_VERIFIED_2FA = "Confirmă-ți adresa de e-mail ca să primești codurile pe e-mail.";
const LINK_DEAD = "Linkul de confirmare a expirat sau nu mai e valabil. Cere unul nou din aplicație.";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Emite un link nou (cele nefolosite de dinainte nu mai merg) și trimite e-mailul.
 * Trimiterea nu e așteptată: SMTP-ul nu întârzie răspunsul, iar o eroare de trimitere
 * doar se jurnalizează — utilizatorul poate cere oricând alt link din aplicație.
 */
export async function issueEmailVerification(fastify: FastifyInstance, userId: string) {
  const user = await fastify.prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, email: true, firstName: true, tenant: { select: { subdomain: true } } },
  });
  await fastify.prisma.emailVerificationToken.deleteMany({ where: { userId, usedAt: null } });
  const raw = randomBytes(32).toString("hex");
  await fastify.prisma.emailVerificationToken.create({
    data: { userId, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + VERIFY_TTL_MS) },
  });
  const verifyUrl = `${appUrlFor(user.tenant?.subdomain, env.TENANT_BASE_DOMAIN, env.FRONTEND_URL)}/verify-email?token=${raw}`;
  void sendEmailVerificationEmail({ to: user.email, firstName: user.firstName, verifyUrl }).catch((err) => {
    fastify.log.error({ err, userId }, "Failed to send e-mail verification");
  });
}

/** Linkul din e-mail → adresa confirmată. Idempotent pentru un cont deja confirmat. */
export async function verifyEmail(fastify: FastifyInstance, token: string) {
  const found = await fastify.prisma.emailVerificationToken.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { select: { id: true, isActive: true, emailVerifiedAt: true } } },
  });
  if (!found || !found.user.isActive) throw fastify.httpErrors.badRequest(LINK_DEAD);
  // Contul e deja confirmat (al doilea clic, ori confirmat între timp prin invitație/resetare):
  // nu e nimic de reparat, deci răspunsul e prietenos chiar dacă linkul a fost folosit.
  if (found.user.emailVerifiedAt) return { verified: true, alreadyVerified: true };
  if (found.usedAt || found.expiresAt.getTime() <= Date.now()) throw fastify.httpErrors.badRequest(LINK_DEAD);

  const now = new Date();
  await fastify.prisma.$transaction(async (tx) => {
    // Consum atomic: două cereri concurente cu același link nu pot reuși amândouă.
    const { count } = await tx.emailVerificationToken.updateMany({ where: { id: found.id, usedAt: null }, data: { usedAt: now } });
    if (count !== 1) throw fastify.httpErrors.badRequest(LINK_DEAD);
    await tx.user.updateMany({ where: { id: found.userId, emailVerifiedAt: null }, data: { emailVerifiedAt: now } });
  });
  return { verified: true, alreadyVerified: false };
}

/** „Retrimite e-mailul” din banner. Nu face nimic pentru un cont deja confirmat. */
export async function resendEmailVerification(fastify: FastifyInstance, userId: string) {
  const user = await fastify.prisma.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true, isActive: true } });
  if (!user || !user.isActive) throw fastify.httpErrors.unauthorized("Account inactive");
  if (user.emailVerifiedAt) return { sent: false, alreadyVerified: true };
  await issueEmailVerification(fastify, userId);
  return { sent: true, alreadyVerified: false };
}

/** 403 dacă cel care face acțiunea nu și-a confirmat adresa (invitarea colegilor). */
export async function assertActorEmailVerified(fastify: FastifyInstance, userId: string) {
  const actor = await fastify.prisma.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } });
  if (actor && !actor.emailVerifiedAt) throw fastify.httpErrors.forbidden(EMAIL_NOT_VERIFIED_INVITE);
}
