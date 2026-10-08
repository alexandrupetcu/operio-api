import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { env } from "../config/env.js";
import { isMobileDeviceRevoked } from "../lib/mobile-devices.js";

export type ClientKind = "web" | "mobile";

export interface JwtPayload {
  sub: string;
  tenantId: string | null;
  role: "MASTER_ADMIN" | "ADMIN" | "MANAGER" | "OPERATOR";
  /** Bound at login; lets any route know where the call comes from with no DB read. */
  client?: ClientKind;
  /** Mobile sessions only: the phone the session is tied to. */
  deviceId?: string;
}

export default fp(async (fastify: FastifyInstance) => {
  fastify.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_ACCESS_EXPIRY },
  });

  fastify.decorate(
    "authenticate",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.unauthorized("Invalid or expired token");
      }
      // Instant revocation for phones: one Redis lookup, mobile tokens only.
      const { client, deviceId, sub } = request.user;
      if (client === "mobile" && deviceId && (await isMobileDeviceRevoked(sub, deviceId))) {
        return reply.unauthorized("Dispozitivul a fost revocat");
      }
    }
  );

  /** Route guard: only sessions opened from the given client kind. */
  fastify.decorate("requireClient", (kind: ClientKind) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      if ((request.user.client ?? "web") !== kind) {
        return reply.forbidden(
          kind === "mobile" ? "Disponibil doar din aplicația mobilă" : "Disponibil doar din aplicația web",
        );
      }
    };
  });
});

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<void>;
    requireClient: (
      kind: ClientKind
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}
