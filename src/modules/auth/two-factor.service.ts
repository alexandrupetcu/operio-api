import type { FastifyInstance } from "fastify";
import type { User } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { env } from "../../config/env.js";
import { verifyPassword } from "../../lib/hash.js";
import { decryptSecret, encryptSecret, parseSecretKey } from "../../lib/crypto-secret.js";
import { newTotpSecret, totpQrDataUrl, totpUri, verifyTotp } from "../../lib/totp.js";
import {
  deviceLabel,
  generateBackupCodes,
  generateEmailCode,
  hashBackupCode,
  verifyBackupCode,
  hashEmailCode,
  maskEmail,
  normalizeBackupCode,
  safeEqualHex,
} from "../../lib/two-factor.js";
import { isEmailConfigured, sendTwoFactorChangedEmail, sendTwoFactorCodeEmail } from "../../lib/email.js";
import { logAudit } from "../../lib/audit.js";
import { hashRefreshToken, issueTokens, loginResponse } from "./auth.service.js";

/**
 * Autentificarea în doi pași — opțională, pe cont, doar pe web (login-ul din aplicația
 * mobilă rămâne neschimbat: acolo protejează telefonul aprobat de admin și amprenta).
 *
 * Metode: cod de 6 cifre pe e-mail sau aplicație de autentificare (TOTP). Plus 10 coduri
 * de rezervă de unică folosință și „ține minte acest dispozitiv 30 de zile”.
 *
 * Fluxul de login: parola corectă → `startLoginChallenge` întoarce un tichet (nu tokenuri);
 * `verifyLogin` schimbă tichetul + codul pe sesiunea web obișnuită. Tichetul, codurile pe
 * e-mail, codurile de rezervă și tokenurile de dispozitiv stau în bază doar ca SHA-256;
 * secretul TOTP e criptat cu TWO_FACTOR_KEY.
 */

export type TwoFactorMethod = "email" | "totp";

const CODE_TTL_MS = 10 * 60 * 1000;
// Scanarea QR-ului și instalarea aplicației pot dura mai mult decât un cod pe e-mail.
const TOTP_SETUP_TTL_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_INTERVAL_MS = 30 * 1000;
const MAX_SENDS = 5;
const TRUSTED_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Cheia secretelor TOTP; lipsă → 503 cu un mesaj clar (metoda e-mail merge în continuare). */
function requireKey(fastify: FastifyInstance): Buffer {
  const key = parseSecretKey(env.TWO_FACTOR_KEY);
  if (!key) {
    throw fastify.httpErrors.serviceUnavailable(
      "Aplicația de autentificare nu este disponibilă momentan pe server. Folosește codul pe e-mail sau încearcă mai târziu.",
    );
  }
  return key;
}

const attemptsLeftMessage = (left: number) =>
  left > 0
    ? `Codul nu este corect. Mai ai ${left} ${left === 1 ? "încercare" : "încercări"}.`
    : "Prea multe coduri greșite — autentifică-te din nou.";

/**
 * Rezervă o încercare pe provocare înainte de a verifica codul: incrementul e atomic
 * și condiționat, deci nici cereri în paralel nu pot depăși 5 încercări.
 */
async function reserveAttempt(fastify: FastifyInstance, challengeId: string): Promise<boolean> {
  const { count } = await fastify.prisma.twoFactorChallenge.updateMany({
    where: { id: challengeId, usedAt: null, expiresAt: { gt: new Date() }, attempts: { lt: MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  return count === 1;
}

async function consumeChallenge(fastify: FastifyInstance, challengeId: string): Promise<boolean> {
  const { count } = await fastify.prisma.twoFactorChallenge.updateMany({
    where: { id: challengeId, usedAt: null },
    data: { usedAt: new Date() },
  });
  return count === 1;
}

/** Codul TOTP al contului; pasul folosit se reține atomic, ca același cod să nu meargă de două ori. */
async function checkUserTotp(fastify: FastifyInstance, user: User, code: string): Promise<boolean> {
  if (!user.twoFactorSecret) return false;
  const secret = decryptSecret(user.twoFactorSecret, requireKey(fastify));
  const step = await verifyTotp(secret, code, user.twoFactorLastStep != null ? { afterTimeStep: user.twoFactorLastStep } : {});
  if (step === null) return false;
  const { count } = await fastify.prisma.user.updateMany({
    where: { id: user.id, OR: [{ twoFactorLastStep: null }, { twoFactorLastStep: { lt: step } }] },
    data: { twoFactorLastStep: step },
  });
  return count === 1;
}

async function consumeBackupCode(fastify: FastifyInstance, userId: string, input: string): Promise<boolean> {
  const code = normalizeBackupCode(input);
  if (!code) return false;
  const unused = await fastify.prisma.twoFactorBackupCode.findMany({ where: { userId, usedAt: null }, select: { id: true, codeHash: true } });
  for (const row of unused) {
    if (!(await verifyBackupCode(row.codeHash, userId, code))) continue;
    // Folosit atomic: două cereri cu același cod nu pot trece amândouă.
    const { count } = await fastify.prisma.twoFactorBackupCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    return count === 1;
  }
  return false;
}

const isSixDigits = (code: string) => /^\d{6}$/.test(code);
const cleanCode = (code: string) => code.trim().replace(/\s+/g, "");

/** Trimite codul pe e-mail. La login nu așteptăm SMTP-ul (omul poate cere retrimiterea). */
function deliverCode(fastify: FastifyInstance, user: User, code: string, purpose: "login" | "enable" | "manage") {
  return sendTwoFactorCodeEmail({ to: user.email, firstName: user.firstName, code, purpose }).catch((err) => {
    fastify.log.error({ err, userId: user.id }, "Failed to send 2FA code e-mail");
  });
}

function notify(fastify: FastifyInstance, user: User, event: "enabled" | "disabled" | "reset", method?: TwoFactorMethod) {
  void sendTwoFactorChangedEmail({ to: user.email, firstName: user.firstName, event, method }).catch((err) => {
    fastify.log.error({ err, userId: user.id }, "Failed to send 2FA notice e-mail");
  });
}

async function audit(fastify: FastifyInstance, user: User, actorUserId: string, action: string, after?: unknown) {
  // Jurnalul de audit e pe firmă: conturile de platformă (fără firmă) nu au unde scrie.
  if (!user.tenantId) return;
  await logAudit(fastify, user.tenantId, actorUserId, "User", user.id, action, undefined, after);
}

/**
 * Închide celelalte sesiuni web ale contului (după activare / dezactivare), păstrând-o pe
 * cea din care s-a făcut schimbarea (`keepRefreshToken`). Sesiunile mobile rămân: acolo
 * 2FA nu se cere, deci o reautentificare pe telefon n-ar adăuga nicio protecție.
 */
async function revokeOtherWebSessions(fastify: FastifyInstance, userId: string, keepRefreshToken?: string) {
  await fastify.prisma.refreshToken.deleteMany({
    where: {
      userId,
      client: "web",
      ...(keepRefreshToken ? { token: { not: hashRefreshToken(keepRefreshToken) } } : {}),
    },
  });
}

async function loadUser(fastify: FastifyInstance, userId: string): Promise<User> {
  const user = await fastify.prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.isActive) throw fastify.httpErrors.unauthorized("Account inactive");
  return user;
}

async function checkPassword(fastify: FastifyInstance, user: User, password: string) {
  if (!(await verifyPassword(user.passwordHash, password))) {
    // 400, nu 401: aplicația web tratează 401 ca sesiune expirată.
    throw fastify.httpErrors.badRequest("Parola este incorectă.");
  }
}

async function replaceBackupCodes(tx: Pick<FastifyInstance["prisma"], "twoFactorBackupCode">, userId: string) {
  const codes = generateBackupCodes();
  const hashes = await Promise.all(codes.map((c) => hashBackupCode(userId, c)));
  await tx.twoFactorBackupCode.deleteMany({ where: { userId } });
  await tx.twoFactorBackupCode.createMany({ data: hashes.map((codeHash) => ({ userId, codeHash })) });
  return codes;
}

// ─── Login ──────────────────────────────────────────────────────────────────

/** „Ține minte acest dispozitiv”: tokenul trimis de browser e valid pentru contul ăsta? */
export async function consumeTrustedDevice(fastify: FastifyInstance, userId: string, token: string | undefined): Promise<boolean> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
  const device = await fastify.prisma.trustedDevice.findUnique({ where: { tokenHash: sha256(token) } });
  if (!device || device.userId !== userId || device.expiresAt.getTime() <= Date.now()) return false;
  await fastify.prisma.trustedDevice.update({ where: { id: device.id }, data: { lastUsedAt: new Date() } });
  return true;
}

/** Parola a fost corectă, dar contul cere al doilea pas: tichet de 10 minute (și codul pe e-mail). */
export async function startLoginChallenge(fastify: FastifyInstance, user: User) {
  const method = user.twoFactorMethod as TwoFactorMethod;
  const now = new Date();
  // Curățenie: provocările vechi ale contului nu mai folosesc nimănui.
  await fastify.prisma.twoFactorChallenge.deleteMany({
    where: { userId: user.id, OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] },
  });
  const ticket = randomBytes(32).toString("hex");
  const challenge = await fastify.prisma.twoFactorChallenge.create({
    data: { userId: user.id, purpose: "login", method, tokenHash: sha256(ticket), expiresAt: new Date(now.getTime() + CODE_TTL_MS) },
  });
  if (method === "email") {
    const code = generateEmailCode();
    await fastify.prisma.twoFactorChallenge.update({
      where: { id: challenge.id },
      data: { codeHash: hashEmailCode(challenge.id, code), sends: 1, lastSentAt: now },
    });
    void deliverCode(fastify, user, code, "login");
  }
  return { twoFactorRequired: true as const, method, ticket, emailHint: maskEmail(user.email) };
}

const deadTicket = (fastify: FastifyInstance) =>
  fastify.httpErrors.unauthorized("Codul a expirat. Introdu din nou e-mailul și parola.");

async function findLoginChallenge(fastify: FastifyInstance, ticket: string) {
  const ch = await fastify.prisma.twoFactorChallenge.findUnique({ where: { tokenHash: sha256(ticket) } });
  if (!ch || ch.purpose !== "login" || ch.usedAt || ch.expiresAt.getTime() <= Date.now()) throw deadTicket(fastify);
  return ch;
}

/** Tichet + cod (TOTP, e-mail sau de rezervă) → sesiunea web, exact ca la login. */
export async function verifyLogin(
  fastify: FastifyInstance,
  input: { ticket: string; code: string; rememberDevice?: boolean },
  meta: { userAgent?: string } = {},
) {
  const ch = await findLoginChallenge(fastify, input.ticket);
  if (!(await reserveAttempt(fastify, ch.id))) throw fastify.httpErrors.unauthorized(attemptsLeftMessage(0));

  const user = await fastify.prisma.user.findUnique({
    where: { id: ch.userId },
    include: { tenant: { include: { country: { select: { id: true, name: true, emoji: true } } } } },
  });
  if (!user || !user.isActive || !user.twoFactorMethod) throw deadTicket(fastify);

  const code = cleanCode(input.code);
  let ok = false;
  if (isSixDigits(code)) {
    if (ch.method === "totp") ok = await checkUserTotp(fastify, user, code);
    else ok = !!ch.codeHash && safeEqualHex(ch.codeHash, hashEmailCode(ch.id, code));
  } else {
    ok = await consumeBackupCode(fastify, user.id, code);
  }
  if (!ok) throw fastify.httpErrors.unauthorized(attemptsLeftMessage(MAX_ATTEMPTS - (ch.attempts + 1)));
  if (!(await consumeChallenge(fastify, ch.id))) throw deadTicket(fastify);

  const tokens = await issueTokens(fastify, { id: user.id, tenantId: user.tenantId, role: user.role }, { client: "web" });
  let trustedDeviceToken: string | undefined;
  if (input.rememberDevice) {
    trustedDeviceToken = randomBytes(32).toString("hex");
    await fastify.prisma.trustedDevice.create({
      data: {
        userId: user.id,
        tokenHash: sha256(trustedDeviceToken),
        label: deviceLabel(meta.userAgent),
        expiresAt: new Date(Date.now() + TRUSTED_DEVICE_TTL_MS),
        lastUsedAt: new Date(),
      },
    });
  }
  return { ...loginResponse(user, tokens), ...(trustedDeviceToken ? { trustedDeviceToken } : {}) };
}

/** „Retrimite codul”: cel mult o dată la 30 s și de 5 ori pe tichet; codul vechi nu mai merge. */
export async function resendLoginCode(fastify: FastifyInstance, ticket: string) {
  const ch = await findLoginChallenge(fastify, ticket);
  if (ch.method !== "email") throw fastify.httpErrors.badRequest("Codul se găsește în aplicația de autentificare.");
  if (ch.sends >= MAX_SENDS) throw fastify.httpErrors.tooManyRequests("Ai cerut prea multe coduri. Autentifică-te din nou.");
  const wait = ch.lastSentAt ? RESEND_INTERVAL_MS - (Date.now() - ch.lastSentAt.getTime()) : 0;
  if (wait > 0) throw fastify.httpErrors.tooManyRequests(`Poți cere un cod nou peste ${Math.ceil(wait / 1000)} s.`);

  const code = generateEmailCode();
  const now = new Date();
  const { count } = await fastify.prisma.twoFactorChallenge.updateMany({
    where: { id: ch.id, usedAt: null, sends: ch.sends },
    data: { codeHash: hashEmailCode(ch.id, code), sends: { increment: 1 }, lastSentAt: now, expiresAt: new Date(now.getTime() + CODE_TTL_MS) },
  });
  if (count !== 1) throw fastify.httpErrors.tooManyRequests("Poți cere un cod nou peste câteva secunde.");
  const user = await loadUser(fastify, ch.userId);
  void deliverCode(fastify, user, code, "login");
  return { resent: true, emailHint: maskEmail(user.email) };
}

// ─── Setări (cont autentificat) ─────────────────────────────────────────────

export async function status(fastify: FastifyInstance, userId: string) {
  const user = await loadUser(fastify, userId);
  const [backupCodesRemaining, trustedDevices] = await Promise.all([
    fastify.prisma.twoFactorBackupCode.count({ where: { userId, usedAt: null } }),
    fastify.prisma.trustedDevice.count({ where: { userId, expiresAt: { gt: new Date() } } }),
  ]);
  return {
    enabled: !!user.twoFactorMethod,
    method: (user.twoFactorMethod as TwoFactorMethod | null) ?? null,
    enabledAt: user.twoFactorEnabledAt,
    backupCodesRemaining: user.twoFactorMethod ? backupCodesRemaining : 0,
    trustedDevices,
    totpAvailable: !!parseSecretKey(env.TWO_FACTOR_KEY),
    emailHint: maskEmail(user.email),
  };
}

/** Pasul 1 al activării: TOTP → secret + QR; e-mail → trimite un cod. Se confirmă cu `enable`. */
export async function setup(fastify: FastifyInstance, userId: string, method: TwoFactorMethod) {
  const user = await loadUser(fastify, userId);
  if (user.twoFactorMethod) {
    throw fastify.httpErrors.conflict("Autentificarea în doi pași este deja activă. Dezactiveaz-o întâi ca să schimbi metoda.");
  }
  const now = new Date();
  const previous = await fastify.prisma.twoFactorChallenge.findFirst({
    where: { userId, purpose: "enable", method: "email", usedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (method === "email" && previous?.lastSentAt && now.getTime() - previous.lastSentAt.getTime() < RESEND_INTERVAL_MS) {
    throw fastify.httpErrors.tooManyRequests("Ți-am trimis deja un cod. Poți cere altul peste 30 de secunde.");
  }

  if (method === "totp") {
    const key = requireKey(fastify);
    await fastify.prisma.twoFactorChallenge.deleteMany({ where: { userId, purpose: "enable" } });
    const secret = newTotpSecret();
    await fastify.prisma.twoFactorChallenge.create({
      data: { userId, purpose: "enable", method, secret: encryptSecret(secret, key), expiresAt: new Date(now.getTime() + TOTP_SETUP_TTL_MS) },
    });
    const otpauthUrl = totpUri(secret, user.email);
    return { method: "totp" as const, secret, otpauthUrl, qrDataUrl: await totpQrDataUrl(otpauthUrl) };
  }

  if (!isEmailConfigured() && env.NODE_ENV === "production") {
    throw fastify.httpErrors.serviceUnavailable("Trimiterea e-mailurilor nu este configurată pe server. Folosește aplicația de autentificare.");
  }
  await fastify.prisma.twoFactorChallenge.deleteMany({ where: { userId, purpose: "enable" } });
  const challenge = await fastify.prisma.twoFactorChallenge.create({
    data: { userId, purpose: "enable", method, expiresAt: new Date(now.getTime() + CODE_TTL_MS), sends: 1, lastSentAt: now },
  });
  const code = generateEmailCode();
  await fastify.prisma.twoFactorChallenge.update({ where: { id: challenge.id }, data: { codeHash: hashEmailCode(challenge.id, code) } });
  await deliverCode(fastify, user, code, "enable");
  return { method: "email" as const, emailHint: maskEmail(user.email) };
}

/** Pasul 2: parola + codul din metoda aleasă → 2FA activ; întoarce codurile de rezervă (o singură dată). */
export async function enable(
  fastify: FastifyInstance,
  userId: string,
  input: { code: string; password: string; refreshToken?: string },
) {
  const user = await loadUser(fastify, userId);
  if (user.twoFactorMethod) throw fastify.httpErrors.conflict("Autentificarea în doi pași este deja activă.");
  await checkPassword(fastify, user, input.password);

  const ch = await fastify.prisma.twoFactorChallenge.findFirst({
    where: { userId, purpose: "enable", usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!ch) throw fastify.httpErrors.badRequest("Configurarea a expirat. Începe din nou.");
  if (!(await reserveAttempt(fastify, ch.id))) throw fastify.httpErrors.badRequest("Prea multe coduri greșite. Începe din nou configurarea.");

  const code = cleanCode(input.code);
  let step: number | null = null;
  let ok = false;
  if (isSixDigits(code)) {
    if (ch.method === "totp" && ch.secret) {
      step = await verifyTotp(decryptSecret(ch.secret, requireKey(fastify)), code);
      ok = step !== null;
    } else if (ch.method === "email" && ch.codeHash) {
      ok = safeEqualHex(ch.codeHash, hashEmailCode(ch.id, code));
    }
  }
  if (!ok) throw fastify.httpErrors.badRequest("Codul nu este corect.");

  const method = ch.method as TwoFactorMethod;
  const backupCodes = await fastify.prisma.$transaction(async (tx) => {
    const consumed = await tx.twoFactorChallenge.updateMany({ where: { id: ch.id, usedAt: null }, data: { usedAt: new Date() } });
    if (consumed.count !== 1) throw fastify.httpErrors.badRequest("Configurarea a expirat. Începe din nou.");
    await tx.user.update({
      where: { id: userId },
      data: {
        twoFactorMethod: method,
        // Deja criptat (la setup) cu aceeași cheie.
        twoFactorSecret: method === "totp" ? ch.secret : null,
        twoFactorEnabledAt: new Date(),
        twoFactorLastStep: step,
      },
    });
    await tx.trustedDevice.deleteMany({ where: { userId } });
    return replaceBackupCodes(tx, userId);
  });
  await revokeOtherWebSessions(fastify, userId, input.refreshToken);
  notify(fastify, user, "enabled", method);
  await audit(fastify, user, userId, "2fa.enable", { method });
  return { method, backupCodes };
}

/** Cod pe e-mail pentru dezactivare / coduri de rezervă noi (contul cu metoda e-mail). */
export async function sendManageCode(fastify: FastifyInstance, userId: string) {
  const user = await loadUser(fastify, userId);
  if (user.twoFactorMethod !== "email") {
    throw fastify.httpErrors.badRequest("Codul se găsește în aplicația de autentificare.");
  }
  const now = new Date();
  const previous = await fastify.prisma.twoFactorChallenge.findFirst({
    where: { userId, purpose: "manage", usedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (previous?.lastSentAt && now.getTime() - previous.lastSentAt.getTime() < RESEND_INTERVAL_MS) {
    throw fastify.httpErrors.tooManyRequests("Ți-am trimis deja un cod. Poți cere altul peste 30 de secunde.");
  }
  await fastify.prisma.twoFactorChallenge.deleteMany({ where: { userId, purpose: "manage" } });
  const ch = await fastify.prisma.twoFactorChallenge.create({
    data: { userId, purpose: "manage", method: "email", expiresAt: new Date(now.getTime() + CODE_TTL_MS), sends: 1, lastSentAt: now },
  });
  const code = generateEmailCode();
  await fastify.prisma.twoFactorChallenge.update({ where: { id: ch.id }, data: { codeHash: hashEmailCode(ch.id, code) } });
  await deliverCode(fastify, user, code, "manage");
  return { sent: true, emailHint: maskEmail(user.email) };
}

/** Parola + un cod valid (TOTP / e-mail cerut cu `sendManageCode` / de rezervă), pentru schimbări de securitate. */
async function requirePasswordAndCode(fastify: FastifyInstance, user: User, password: string, rawCode: string) {
  if (!user.twoFactorMethod) throw fastify.httpErrors.badRequest("Autentificarea în doi pași nu este activă.");
  await checkPassword(fastify, user, password);
  const code = cleanCode(rawCode);
  let ok = false;
  if (isSixDigits(code)) {
    if (user.twoFactorMethod === "totp") {
      ok = await checkUserTotp(fastify, user, code);
    } else {
      const ch = await fastify.prisma.twoFactorChallenge.findFirst({
        where: { userId: user.id, purpose: "manage", usedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
      });
      if (ch && ch.codeHash && (await reserveAttempt(fastify, ch.id))) {
        ok = safeEqualHex(ch.codeHash, hashEmailCode(ch.id, code)) && (await consumeChallenge(fastify, ch.id));
      }
    }
  } else {
    ok = await consumeBackupCode(fastify, user.id, code);
  }
  if (!ok) throw fastify.httpErrors.badRequest("Codul nu este corect.");
}

async function clearTwoFactor(fastify: FastifyInstance, userId: string) {
  await fastify.prisma.$transaction([
    fastify.prisma.user.update({
      where: { id: userId },
      data: { twoFactorMethod: null, twoFactorSecret: null, twoFactorEnabledAt: null, twoFactorLastStep: null },
    }),
    fastify.prisma.twoFactorBackupCode.deleteMany({ where: { userId } }),
    fastify.prisma.trustedDevice.deleteMany({ where: { userId } }),
    fastify.prisma.twoFactorChallenge.deleteMany({ where: { userId } }),
  ]);
}

export async function disable(
  fastify: FastifyInstance,
  userId: string,
  input: { password: string; code: string; refreshToken?: string },
) {
  const user = await loadUser(fastify, userId);
  await requirePasswordAndCode(fastify, user, input.password, input.code);
  await clearTwoFactor(fastify, userId);
  await revokeOtherWebSessions(fastify, userId, input.refreshToken);
  notify(fastify, user, "disabled");
  await audit(fastify, user, userId, "2fa.disable", { method: user.twoFactorMethod });
  return { enabled: false };
}

export async function regenerateBackupCodes(fastify: FastifyInstance, userId: string, input: { password: string; code: string }) {
  const user = await loadUser(fastify, userId);
  await requirePasswordAndCode(fastify, user, input.password, input.code);
  const backupCodes = await fastify.prisma.$transaction((tx) => replaceBackupCodes(tx, userId));
  return { backupCodes };
}

export async function listTrustedDevices(fastify: FastifyInstance, userId: string) {
  return fastify.prisma.trustedDevice.findMany({
    where: { userId, expiresAt: { gt: new Date() } },
    select: { id: true, label: true, createdAt: true, lastUsedAt: true, expiresAt: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function forgetTrustedDevice(fastify: FastifyInstance, userId: string, id: string) {
  const { count } = await fastify.prisma.trustedDevice.deleteMany({ where: { id, userId } });
  if (count === 0) throw fastify.httpErrors.notFound("Dispozitivul nu a fost găsit");
  return { ok: true };
}

export async function forgetAllTrustedDevices(fastify: FastifyInstance, userId: string) {
  const { count } = await fastify.prisma.trustedDevice.deleteMany({ where: { userId } });
  return { removed: count };
}

/**
 * Reset de către administrator (telefon pierdut, fără coduri de rezervă). `actor.tenantId`
 * = firma adminului: poate reseta doar conturile firmei lui; null = administratorul
 * platformei (orice cont). Utilizatorul primește un e-mail.
 */
export async function adminReset(fastify: FastifyInstance, targetUserId: string, actor: { userId: string; tenantId: string | null }) {
  const user = await fastify.prisma.user.findFirst({
    where: { id: targetUserId, ...(actor.tenantId ? { tenantId: actor.tenantId } : {}) },
  });
  if (!user) throw fastify.httpErrors.notFound("Utilizatorul nu a fost găsit");
  if (!user.twoFactorMethod) return { reset: false };
  await clearTwoFactor(fastify, user.id);
  notify(fastify, user, "reset");
  await audit(fastify, user, actor.userId, "2fa.reset", { method: user.twoFactorMethod });
  return { reset: true };
}
