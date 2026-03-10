import type { FastifyInstance } from "fastify";
import { randomBytes } from "crypto";
import { hashPassword, verifyPassword } from "../../lib/hash.js";
import { env } from "../../config/env.js";
import type { RegisterInput, LoginInput } from "./auth.schema.js";

function generateRefreshToken(): string {
  return randomBytes(64).toString("hex");
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
      token: refreshToken,
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
    },
  };
}

export async function login(fastify: FastifyInstance, input: LoginInput) {
  const tenant = await fastify.prisma.tenant.findUnique({
    where: { slug: input.tenantSlug },
  });
  if (!tenant) {
    throw fastify.httpErrors.unauthorized("Invalid credentials");
  }

  const user = await fastify.prisma.user.findUnique({
    where: { tenantId_email: { tenantId: tenant.id, email: input.email } },
  });
  if (!user || !user.isActive) {
    throw fastify.httpErrors.unauthorized("Invalid credentials");
  }

  const valid = await verifyPassword(user.passwordHash, input.password);
  if (!valid) {
    throw fastify.httpErrors.unauthorized("Invalid credentials");
  }

  const accessToken = fastify.jwt.sign({
    sub: user.id,
    tenantId: tenant.id,
    role: user.role,
  });

  const refreshToken = generateRefreshToken();
  await fastify.prisma.refreshToken.create({
    data: {
      userId: user.id,
      token: refreshToken,
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
    tenant: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
    },
  };
}

export async function refresh(fastify: FastifyInstance, token: string) {
  const storedToken = await fastify.prisma.refreshToken.findUnique({
    where: { token },
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
      token: newRefreshToken,
      expiresAt: parseExpiry(env.JWT_REFRESH_EXPIRY),
    },
  });

  return { accessToken, refreshToken: newRefreshToken };
}

export async function logout(fastify: FastifyInstance, userId: string) {
  await fastify.prisma.refreshToken.deleteMany({ where: { userId } });
}
