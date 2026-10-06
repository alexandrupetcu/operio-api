import type { FastifyInstance } from "fastify";
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "./auth.schema.js";
import * as authService from "./auth.service.js";

export default async function authRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/register",
    {
      // Tight per-IP cap on tenant creation — registration is permanent and
      // a common abuse vector.
      config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
    },
    async (request, reply) => {
      const body = registerSchema.parse(request.body);
      const result = await authService.register(fastify, body);
      return reply.status(201).send(result);
    }
  );

  fastify.post(
    "/login",
    {
      // 5 attempts / IP / minute lets a real user retry typos without
      // permitting meaningful brute-force.
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const body = loginSchema.parse(request.body);
      const result = await authService.login(fastify, body);
      return reply.send(result);
    }
  );

  fastify.post(
    "/refresh",
    {
      // Refresh is invoked on every access-token expiry (~15min) plus
      // occasional retry storms; cap at 30/min/IP so a misbehaving client
      // can't accidentally DoS itself without blocking legitimate use.
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const body = refreshSchema.parse(request.body);
      const result = await authService.refresh(fastify, body.refreshToken);
      return reply.send(result);
    }
  );

  fastify.post(
    "/logout",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      await authService.logout(fastify, request.user.sub);
      return reply.send({ message: "Logged out" });
    }
  );

  // Hydrate `{ user, tenant }` for a verified access token. Used by the
  // frontend AuthProvider to recover session state on page reload without
  // mirroring user/tenant into localStorage.
  fastify.get(
    "/me",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const me = await authService.me(fastify, request.user.sub);
      return reply.send(me);
    }
  );

  fastify.post(
    "/change-password",
    {
      onRequest: [fastify.authenticate],
      config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
    },
    async (request, reply) => {
      const body = changePasswordSchema.parse(request.body);
      await authService.changePassword(fastify, request.user.sub, body);
      return reply.send({ message: "Parola a fost schimbată" });
    }
  );

  fastify.post(
    "/forgot-password",
    {
      // Tighter than login because each successful call sends an email →
      // attacker can use this to spam mailboxes / probe valid accounts.
      config: { rateLimit: { max: 3, timeWindow: "1 hour" } },
    },
    async (request, reply) => {
      const body = forgotPasswordSchema.parse(request.body);
      await authService.forgotPassword(fastify, body);
      // Always 200, regardless of whether the email exists — prevents
      // user-enumeration via the reset endpoint.
      return reply.send({ message: "Dacă există un cont cu acel email, vei primi un link." });
    }
  );

  fastify.post(
    "/reset-password",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
    },
    async (request, reply) => {
      const body = resetPasswordSchema.parse(request.body);
      await authService.resetPassword(fastify, body);
      return reply.send({ message: "Parola a fost resetată" });
    }
  );
}
