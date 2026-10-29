import { resolveEntitlements, serializeEntitlements } from "../../lib/entitlements/index.js";
import { ensureEmployeeForMobileUser } from "../users/employee-link.js";
import { ensureDefaultProjectTypes } from "../../lib/default-project-types.js";
import { ensureDefaultDistributors } from "../../lib/default-distributors.js";
import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "crypto";
import { hashPassword, verifyPassword } from "../../lib/hash.js";
import { sendPasswordResetEmail } from "../../lib/email.js";
import { env } from "../../config/env.js";
import type {
  RegisterInput,
  LoginInput,
  MobileDeviceInput,
  ChangePasswordInput,
  ForgotPasswordInput,
  ResetPasswordInput,
} from "./auth.schema.js";
import { readSchedulingSettings } from "../tenant/scheduling-settings.js";
import type { ClientKind } from "../../plugins/auth.js";
import { appUrlFor } from "../../lib/tenant-subdomain.js";
import { isMobileDeviceRevoked } from "../../lib/mobile-devices.js";

interface SessionUser {
  id: string;
  tenantId: string | null;
  role: "MASTER_ADMIN" | "ADMIN" | "MANAGER" | "OPERATOR";
}

/**
 * Static argon2 hash verified against when the login e-mail does not match an
 * (active) account, so a failed login costs the same wall-clock time whether
 * or not the account exists — otherwise the response time leaks existence.
 * Computed once, lazily, on the first miss.
 */
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword("operio-dummy-password-for-timing-equalisation");
  }
  return dummyHashPromise;
}

/**
 * Mint an access + refresh token pair. `client`/`deviceId` are stamped into the
 * access token (so routes know the caller without a DB read) and stored on the
 * refresh token so rotation keeps them.
 */
export async function issueTokens(
  fastify: FastifyInstance,
  user: SessionUser,
  session: { client: ClientKind; deviceId?: string },
) {
  const accessToken = fastify.jwt.sign({
    sub: user.id,
    tenantId: user.tenantId,
    role: user.role,
    client: session.client,
    ...(session.deviceId ? { deviceId: session.deviceId } : {}),
  });
  const refreshToken = generateRefreshToken();
  await fastify.prisma.refreshToken.create({
    data: {
      userId: user.id,
      // Store SHA-256(token) — never the plaintext that's handed to the client.
      token: hashRefreshToken(refreshToken),
      client: session.client,
      deviceId: session.deviceId ?? null,
      expiresAt: parseExpiry(refreshExpiryFor(session.client)),
    },
  });
  return { accessToken, refreshToken };
}

/**
 * Mobile login gate: the account must be opted in (User.mobileAccess) and the
 * phone must not be revoked. First login from a phone registers it
 * automatically; later logins just bump lastSeenAt / model info.
 */
async function registerMobileDevice(
  fastify: FastifyInstance,
  user: { id: string; tenantId: string | null; mobileAccess: boolean },
  device: MobileDeviceInput,
) {
  if (!user.mobileAccess || !user.tenantId) {
    throw fastify.httpErrors.forbidden(
      "Contul nu are acces la aplicația mobilă. Cere administratorului să îl activeze.",
    );
  }
  const existing = await fastify.prisma.mobileDevice.findUnique({
    where: { userId_deviceId: { userId: user.id, deviceId: device.deviceId } },
  });
  if (existing?.status === "revoked") {
    throw fastify.httpErrors.forbidden("Acest telefon a fost revocat de administrator.");
  }
  const info = { platform: device.platform, model: device.model, name: device.name, appVersion: device.appVersion };
  if (existing) {
    await fastify.prisma.mobileDevice.update({ where: { id: existing.id }, data: { ...info, lastSeenAt: new Date() } });
  } else {
    await fastify.prisma.mobileDevice.create({
      data: { tenantId: user.tenantId, userId: user.id, deviceId: device.deviceId, ...info },
    });
  }
}

/** 64 bytes = 512 bits of entropy. Encoded as hex (128 chars). */
function generateRefreshToken(): string {
  return randomBytes(64).toString("hex");
}

/**
 * SHA-256 is fast enough for the auth path (no need for a slow KDF like argon2,
 * because the refresh token itself has 512 bits of entropy → brute-force from
 * the hash is infeasible). What hashing buys us: a DB read-only leak no longer
 * gives the attacker working refresh tokens. The client value is hashed both at
 * write (issue) and read (refresh) so we never see plaintext in the DB.
 */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Cât trăiește refresh token-ul: pe mobil (dispozitiv legat, blocare biometrică) mai mult decât pe web. */
export function refreshExpiryFor(client: ClientKind): string {
  return client === "mobile" ? env.JWT_REFRESH_EXPIRY_MOBILE : env.JWT_REFRESH_EXPIRY;
}

function parseExpiry(expiry: string): Date {
  const match = expiry.match(/^(\d+)([smhd])$/);
  if (!match) throw new Error(`Invalid expiry format: ${expiry}`);
  const value = parseInt(match[1]);
  const unit = match[2];
  const ms = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit]!;
  return new Date(Date.now() + value * ms);
}

/** "Gaz Instal Prahova S.R.L." → "gaz-instal-prahova-srl" */
function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "firma";
}

/** Pick a free slug: the requested/derived one, else with -2, -3, … */
async function uniqueTenantSlug(fastify: FastifyInstance, base: string): Promise<string> {
  const taken = new Set(
    (await fastify.prisma.tenant.findMany({ where: { slug: { startsWith: base } }, select: { slug: true } })).map((t) => t.slug),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base.slice(0, 50 - String(i).length - 1)}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw fastify.httpErrors.conflict("Tenant slug already taken");
}

export async function register(fastify: FastifyInstance, input: RegisterInput) {
  const existingUser = await fastify.prisma.user.findFirst({ where: { email: input.email } });
  if (existingUser) {
    // Generic on purpose — don't confirm that the e-mail has an account.
    throw fastify.httpErrors.conflict("Nu putem crea contul cu aceste date");
  }
  if (input.tenantSlug) {
    const existingTenant = await fastify.prisma.tenant.findUnique({ where: { slug: input.tenantSlug } });
    if (existingTenant) throw fastify.httpErrors.conflict("Tenant slug already taken");
  }
  // One firm = one tenant. A second account on the same CUI is almost always an
  // employee who should be invited by the firm's administrator instead.
  const cuiDigits = input.cui?.replace(/\D/g, "");
  if (cuiDigits) {
    const sameFirm = await fastify.prisma.tenant.findFirst({
      where: { OR: [{ cui: cuiDigits }, { cui: `RO${cuiDigits}` }] },
      select: { id: true },
    });
    if (sameFirm) {
      throw fastify.httpErrors.conflict(
        "Există deja un cont Operio pentru această firmă. Cere administratorului firmei să te invite din Setări → Utilizatori sau folosește „Ai uitat parola?”.",
      );
    }
  }
  const tenantSlug = input.tenantSlug ?? (await uniqueTenantSlug(fastify, slugify(input.tenantName)));

  // Geo ids come from the client; keep only a consistent country → county → city chain that exists.
  let geo: { countryId?: number; stateId?: number; cityId?: number } = {};
  if (input.cityId) {
    const city = await fastify.prisma.city.findUnique({ where: { id: input.cityId }, select: { id: true, stateId: true, countryId: true } });
    if (city) geo = { countryId: city.countryId, stateId: city.stateId, cityId: city.id };
  } else if (input.stateId) {
    const state = await fastify.prisma.state.findUnique({ where: { id: input.stateId }, select: { id: true, countryId: true } });
    if (state) geo = { countryId: state.countryId, stateId: state.id };
  } else if (input.countryId) {
    const country = await fastify.prisma.country.findUnique({ where: { id: input.countryId }, select: { id: true } });
    if (country) geo = { countryId: country.id };
  }

  const passwordHash = await hashPassword(input.password);

  const result = await fastify.prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        name: input.tenantName,
        slug: tenantSlug,
        cui: cuiDigits ? `RO${cuiDigits}` : null,
        regCom: input.regCom || null,
        address: input.address || null,
        phone: input.phone || null,
        adminName: `${input.firstName} ${input.lastName}`.trim(),
        ...geo,
      },
    });

    // Tipurile de proiect de bază (dosare, asistentul de proiect le caută după cod).
    await ensureDefaultProjectTypes(tx, tenant.id);
    // Distribuitorii cu seturi de dosare (workflow-urile generale îi caută după cod).
    await ensureDefaultDistributors(tx, tenant.id);

    const user = await tx.user.create({
      data: {
        tenantId: tenant.id,
        email: input.email,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        role: "ADMIN",
      },
    });

    return { tenant, user };
  });

  const { accessToken, refreshToken } = await issueTokens(
    fastify,
    { id: result.user.id, tenantId: result.tenant.id, role: result.user.role },
    { client: "web" },
  );

  return {
    accessToken,
    refreshToken,
    user: {
      id: result.user.id,
      email: result.user.email,
      firstName: result.user.firstName,
      lastName: result.user.lastName,
      role: result.user.role,
    },
    tenant: {
      id: result.tenant.id,
      name: result.tenant.name,
      slug: result.tenant.slug,
      subdomain: result.tenant.subdomain,
      countryId: result.tenant.countryId,
      country: null,
    },
  };
}

export async function login(fastify: FastifyInstance, input: LoginInput) {
  const user = await fastify.prisma.user.findFirst({
    where: { email: input.email },
    include: {
      tenant: {
        include: { country: { select: { id: true, name: true, emoji: true } } },
      },
    },
  });
  // Unknown / inactive account: still burn an argon2 verify against the dummy
  // hash so the response time is indistinguishable from a wrong password.
  const candidate = user && user.isActive ? user : null;
  const valid = candidate
    ? await verifyPassword(candidate.passwordHash, input.password)
    : (await verifyPassword(await dummyHash(), input.password), false);
  if (!candidate || !valid) {
    throw fastify.httpErrors.unauthorized("Invalid credentials");
  }

  const tenant = candidate.tenant;

  if (input.client === "mobile") {
    await registerMobileDevice(fastify, candidate, input.device!);
    // Contul cu acces mobil dat înainte de regula „acces = angajat legat” primește
    // angajatul la primul login din telefon (idempotent).
    if (tenant) await ensureEmployeeForMobileUser(fastify, { id: candidate.id, tenantId: tenant.id });
  }

  const { accessToken, refreshToken } = await issueTokens(
    fastify,
    { id: candidate.id, tenantId: tenant?.id ?? null, role: candidate.role },
    { client: input.client, deviceId: input.client === "mobile" ? input.device!.deviceId : undefined },
  );

  return {
    accessToken,
    refreshToken,
    user: {
      id: candidate.id,
      email: candidate.email,
      firstName: candidate.firstName,
      lastName: candidate.lastName,
      role: candidate.role,
      mobileAccess: candidate.mobileAccess,
    },
    tenant: tenant
      ? {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          subdomain: tenant.subdomain,
          countryId: tenant.countryId,
          country: tenant.country,
        }
      : null,
  };
}

export async function refresh(fastify: FastifyInstance, token: string) {
  // Look up by the SHA-256 hash of the supplied token — the DB never stores
  // the plaintext value the client holds.
  const tokenHash = hashRefreshToken(token);

  // Rotation is atomic + reuse-detecting: the lookup and the delete of the old
  // token run in one transaction. If two requests race with the same token,
  // only one `deleteMany` sees a row — the other means the token was already
  // rotated (replayed / stolen), so we revoke every session of that user.
  const storedToken = await fastify.prisma.$transaction(async (tx) => {
    const found = await tx.refreshToken.findUnique({
      where: { token: tokenHash },
      include: { user: true },
    });
    if (!found) {
      throw fastify.httpErrors.unauthorized("Invalid or expired refresh token");
    }
    if (found.expiresAt < new Date()) {
      await tx.refreshToken.delete({ where: { id: found.id } });
      throw fastify.httpErrors.unauthorized("Invalid or expired refresh token");
    }

    const { count } = await tx.refreshToken.deleteMany({
      where: { token: tokenHash, userId: found.userId },
    });
    if (count === 0) {
      await tx.refreshToken.deleteMany({ where: { userId: found.userId } });
      throw fastify.httpErrors.unauthorized(
        "Token de reîmprospătare refolosit — sesiunile au fost revocate",
      );
    }
    return found;
  });

  const { user } = storedToken;
  if (!user.isActive) throw fastify.httpErrors.unauthorized("Account inactive");

  const client = (storedToken.client as ClientKind) ?? "web";
  const deviceId = storedToken.deviceId ?? undefined;
  if (client === "mobile") {
    // Mobile sessions re-check the gate on every rotation (≤ access expiry):
    // access switched off, phone revoked, or denylisted since the last token.
    const device = deviceId
      ? await fastify.prisma.mobileDevice.findUnique({ where: { userId_deviceId: { userId: user.id, deviceId } } })
      : null;
    if (!user.mobileAccess || !device || device.status !== "active" || (await isMobileDeviceRevoked(user.id, device.deviceId))) {
      throw fastify.httpErrors.unauthorized("Accesul de pe acest telefon a fost revocat");
    }
    await fastify.prisma.mobileDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
  }

  const { accessToken, refreshToken: newRefreshToken } = await issueTokens(
    fastify,
    { id: user.id, tenantId: user.tenantId, role: user.role },
    { client, deviceId },
  );
  return { accessToken, refreshToken: newRefreshToken };
}

export async function logout(fastify: FastifyInstance, userId: string) {
  await fastify.prisma.refreshToken.deleteMany({ where: { userId } });
}

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Forgot password — fire-and-forget. Always returns void; the route returns
 * an identical 200 whether the email exists or not, so a caller can't enumerate
 * accounts. If the user exists, we generate a random 32-byte token, store its
 * SHA-256, and email the plaintext as a single-use link. The e-mail itself is
 * sent without awaiting so the SMTP round-trip doesn't show up in the response
 * time (which would otherwise reveal that the account exists).
 */
export async function forgotPassword(
  fastify: FastifyInstance,
  input: ForgotPasswordInput,
) {
  const user = await fastify.prisma.user.findFirst({
    where: { email: input.email, isActive: true },
  });
  if (!user) return; // silent success — anti-enumeration

  // Invalidate any pending resets for this user (only the newest link works).
  await fastify.prisma.passwordResetToken.deleteMany({
    where: { userId: user.id, usedAt: null },
  });

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  await fastify.prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  });

  const tenant = user.tenantId
    ? await fastify.prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { subdomain: true } })
    : null;
  const resetUrl = `${appUrlFor(tenant?.subdomain, env.TENANT_BASE_DOMAIN, env.FRONTEND_URL)}/reset-password?token=${rawToken}`;
  // Best-effort and NOT awaited: don't block the response on SMTP (timing
  // leak) and don't surface email failures to the caller.
  void sendPasswordResetEmail({
    to: user.email,
    firstName: user.firstName,
    resetUrl,
  }).catch((err) => {
    fastify.log.error({ err, userId: user.id }, "Failed to send password reset email");
  });
}

/**
 * Reset password using the emailed token. Looks up by hash, enforces expiry +
 * single-use, then atomically updates the password hash, marks the token used,
 * and invalidates every refresh token for the user.
 */
export async function resetPassword(
  fastify: FastifyInstance,
  input: ResetPasswordInput,
) {
  const tokenHash = createHash("sha256").update(input.token).digest("hex");
  const stored = await fastify.prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { user: { select: { isActive: true } } },
  });
  if (!stored || stored.usedAt || stored.expiresAt < new Date()) {
    throw fastify.httpErrors.badRequest("Link-ul de resetare e invalid sau a expirat");
  }
  // Un cont dezactivat nu-și poate reseta parola (același mesaj — nu dezvăluim starea contului).
  if (!stored.user.isActive) {
    throw fastify.httpErrors.badRequest("Link-ul de resetare e invalid sau a expirat");
  }

  const newHash = await hashPassword(input.newPassword);
  await fastify.prisma.$transaction(async (tx) => {
    // Consumul token-ului e condiționat (`usedAt: null`) și verificat în aceeași
    // tranzacție: două cereri concurente cu același link nu pot reuși amândouă.
    const consumed = await tx.passwordResetToken.updateMany({
      where: { id: stored.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (consumed.count !== 1) {
      throw fastify.httpErrors.badRequest("Link-ul de resetare e invalid sau a expirat");
    }
    await tx.user.update({
      where: { id: stored.userId },
      data: { passwordHash: newHash, invitePending: false },
    });
    await tx.refreshToken.deleteMany({ where: { userId: stored.userId } });
  });
}

/** Authenticated self-service password change. Verifies the current
 *  password, then atomically writes the new hash + invalidates every
 *  refresh token for the user (forcing every other device to re-login). */
export async function changePassword(
  fastify: FastifyInstance,
  userId: string,
  input: ChangePasswordInput,
) {
  if (input.currentPassword === input.newPassword) {
    throw fastify.httpErrors.badRequest("Parola nouă trebuie să fie diferită de cea curentă");
  }
  const user = await fastify.prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw fastify.httpErrors.unauthorized("User not found");
  const valid = await verifyPassword(user.passwordHash, input.currentPassword);
  if (!valid) throw fastify.httpErrors.unauthorized("Parola curentă este incorectă");

  const newHash = await hashPassword(input.newPassword);
  await fastify.prisma.$transaction([
    fastify.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newHash },
    }),
    fastify.prisma.refreshToken.deleteMany({ where: { userId } }),
  ]);
}

/**
 * `GET /auth/me` cu un token de impersonare (master → firmă, doar citire): numele
 * contului master, rolul ADMIN în firma țintă, fără persoană din echipă.
 */
export async function impersonatedMe(
  fastify: FastifyInstance,
  token: { sub: string; tenantId: string | null; exp?: number },
) {
  const [user, tenant] = await Promise.all([
    fastify.prisma.user.findUnique({ where: { id: token.sub } }),
    token.tenantId
      ? fastify.prisma.tenant.findUnique({
          where: { id: token.tenantId },
          include: { country: { select: { id: true, name: true, emoji: true } } },
        })
      : null,
  ]);
  if (!user || !user.isActive || user.role !== "MASTER_ADMIN" || !tenant) {
    throw fastify.httpErrors.unauthorized("Sesiunea de impersonare nu mai este validă");
  }
  return {
    entitlements: serializeEntitlements(resolveEntitlements(tenant)),
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: "ADMIN" as const,
      tenantId: tenant.id,
      mobileAccess: false,
    },
    employee: null,
    scheduling: readSchedulingSettings(tenant.settingsJson),
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, subdomain: tenant.subdomain, countryId: tenant.countryId, country: tenant.country },
    impersonation: {
      tenantId: tenant.id,
      tenantName: tenant.name,
      readOnly: true,
      expiresAt: token.exp ? new Date(token.exp * 1000).toISOString() : null,
    },
  };
}

/** Hydrate `{ user, tenant }` for the access-token holder. Lets the frontend
 *  recover session state on reload without mirroring sensitive user/tenant
 *  data into localStorage. */
export async function me(fastify: FastifyInstance, userId: string) {
  const user = await fastify.prisma.user.findUnique({
    where: { id: userId },
    include: {
      tenant: {
        include: { country: { select: { id: true, name: true, emoji: true } } },
      },
      // Persoana din echipă legată de acest cont, dacă există. E singurul loc din
      // care ambii clienți află „sunt tehnician?" — programările se atribuie unui
      // Employee, nu unui User.
      employee: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  if (!user || !user.isActive) {
    throw fastify.httpErrors.unauthorized("Account inactive");
  }
  const tenant = user.tenant;
  const entitlements = tenant ? serializeEntitlements(resolveEntitlements(tenant)) : null;
  return {
    entitlements,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      mobileAccess: user.mobileAccess,
    },
    employee: user.employee,
    // Modul de programare al firmei — clienții decid pe baza lui ce afișează.
    scheduling: readSchedulingSettings(tenant?.settingsJson),
    tenant: tenant
      ? {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          subdomain: tenant.subdomain,
          countryId: tenant.countryId,
          country: tenant.country,
        }
      : null,
  };
}
