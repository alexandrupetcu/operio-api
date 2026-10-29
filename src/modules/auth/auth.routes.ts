import type { FastifyInstance } from "fastify";
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "./auth.schema.js";
import { z } from "zod";
import { env } from "../../config/env.js";
import { exchangeHandoff, startHandoff } from "./handoff.service.js";
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
      // Un token de impersonare aparține contului master: nu-i revocăm sesiunile proprii.
      if (!request.user.imp) await authService.logout(fastify, request.user.sub);
      return reply.send({ message: "Logged out" });
    }
  );

  // Mutarea sesiunii pe adresa firmei (`picinstall.operio.ro`): sesiunea de pe adresa curentă
  // se închide, iar aplicația merge la linkul cu codul de unică folosință (60 s).
  fastify.post(
    "/handoff",
    { onRequest: [fastify.authenticate], config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => {
      if (request.user.imp) throw fastify.httpErrors.badRequest("Vizualizarea unei firme rămâne pe adresa comună");
      const body = z.object({ refreshToken: z.string().max(200).optional() }).parse(request.body ?? {});
      const { url } = await startHandoff(fastify, request.user.sub, body.refreshToken ?? null, {
        baseDomain: env.TENANT_BASE_DOMAIN,
        frontendUrl: env.FRONTEND_URL,
      });
      return { url };
    },
  );

  fastify.post(
    "/handoff/exchange",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => {
      const body = z.object({ code: z.string().regex(/^[a-f0-9]{64}$/) }).parse(request.body);
      return exchangeHandoff(fastify, body.code, request.headers.origin);
    },
  );

  // Hydrate `{ user, tenant }` for a verified access token. Used by the
  // frontend AuthProvider to recover session state on page reload without
  // mirroring user/tenant into localStorage.
  fastify.get(
    "/me",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const me = request.user.imp
        ? await authService.impersonatedMe(fastify, request.user)
        : await authService.me(fastify, request.user.sub);
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
