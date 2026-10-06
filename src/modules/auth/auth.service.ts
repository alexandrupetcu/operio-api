import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "crypto";
import { hashPassword, verifyPassword } from "../../lib/hash.js";
import { sendPasswordResetEmail } from "../../lib/email.js";
import { env } from "../../config/env.js";
import type {
  RegisterInput,
  LoginInput,
  ChangePasswordInput,
  ForgotPasswordInput,
  ResetPasswordInput,
} from "./auth.schema.js";
import { readSchedulingSettings } from "../tenant/scheduling-settings.js";

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
function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function parseExpiry(expiry: string): Date {
  const match = expiry.match(/^(\d+)([smhd])$/);
  if (!match) throw new Error(`Invalid expiry format: ${expiry}`);
  const value = parseInt(match[1]);
  const unit = match[2];
  const ms = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit]!;
  return new Date(Date.now() + value * ms);
}

export async function register(fastify: FastifyInstance, input: RegisterInput) {
  const existingTenant = await fastify.prisma.tenant.findUnique({
    where: { slug: input.tenantSlug },
  });
  if (existingTenant) {
    throw fastify.httpErrors.conflict("Tenant slug already taken");
  }

  const passwordHash = await hashPassword(input.password);

  const result = await fastify.prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: { name: input.tenantName, slug: input.tenantSlug },
    });

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

  const accessToken = fastify.jwt.sign({
    sub: result.user.id,
    tenantId: result.tenant.id,
    role: result.user.role,
  });

  const refreshToken = generateRefreshToken();
  await fastify.prisma.refreshToken.create({
    data: {
      userId: result.user.id,
      // Store SHA-256(token) — never the plaintext that's handed to the client.
      token: hashRefreshToken(refreshToken),
      expiresAt: parseExpiry(env.JWT_REFRESH_EXPIRY),
    },
  });

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
  if (!user || !user.isActive) {
    throw fastify.httpErrors.unauthorized("Invalid credentials");
  }

  const tenant = user.tenant;

  const valid = await verifyPassword(user.passwordHash, input.password);
  if (!valid) {
    throw fastify.httpErrors.unauthorized("Invalid credentials");
  }

  const accessToken = fastify.jwt.sign({
    sub: user.id,
    tenantId: tenant?.id ?? null,
    role: user.role,
  });

  const refreshToken = generateRefreshToken();
  await fastify.prisma.refreshToken.create({
    data: {
      userId: user.id,
      token: hashRefreshToken(refreshToken),
      expiresAt: parseExpiry(env.JWT_REFRESH_EXPIRY),
    },
  });

  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
    },
    tenant: tenant
      ? {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
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
  const storedToken = await fastify.prisma.refreshToken.findUnique({
    where: { token: tokenHash },
    include: { user: { include: { tenant: true } } },
  });

  if (!storedToken || storedToken.expiresAt < new Date()) {
    if (storedToken) {
      await fastify.prisma.refreshToken.delete({ where: { id: storedToken.id } });
    }
    throw fastify.httpErrors.unauthorized("Invalid or expired refresh token");
  }

  // Rotate: delete old, create new
  await fastify.prisma.refreshToken.delete({ where: { id: storedToken.id } });

  const { user } = storedToken;
  const accessToken = fastify.jwt.sign({
    sub: user.id,
    tenantId: user.tenantId,
    role: user.role,
  });

  const newRefreshToken = generateRefreshToken();
  await fastify.prisma.refreshToken.create({
    data: {
      userId: user.id,
      token: hashRefreshToken(newRefreshToken),
      expiresAt: parseExpiry(env.JWT_REFRESH_EXPIRY),
    },
  });

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
 * SHA-256, and email the plaintext as a single-use link.
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

  const resetUrl = `${env.FRONTEND_URL}/reset-password?token=${rawToken}`;
  // Best-effort: don't block / leak email failures to the caller.
  try {
    await sendPasswordResetEmail({
      to: user.email,
      firstName: user.firstName,
      resetUrl,
    });
  } catch (err) {
    fastify.log.error({ err, userId: user.id }, "Failed to send password reset email");
  }
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
  });
  if (!stored || stored.usedAt || stored.expiresAt < new Date()) {
    throw fastify.httpErrors.badRequest("Link-ul de resetare e invalid sau a expirat");
  }

  const newHash = await hashPassword(input.newPassword);
  await fastify.prisma.$transaction([
    fastify.prisma.user.update({
      where: { id: stored.userId },
      data: { passwordHash: newHash },
    }),
    fastify.prisma.passwordResetToken.update({
      where: { id: stored.id },
      data: { usedAt: new Date() },
    }),
    fastify.prisma.refreshToken.deleteMany({ where: { userId: stored.userId } }),
  ]);
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
  return {
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
    },
    employee: user.employee,
    // Modul de programare al firmei — clienții decid pe baza lui ce afișează.
    scheduling: readSchedulingSettings(tenant?.settingsJson),
    tenant: tenant
      ? {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          countryId: tenant.countryId,
          country: tenant.country,
        }
      : null,
  };
}
