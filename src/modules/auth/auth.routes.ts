import type { FastifyInstance } from "fastify";
import { registerSchema, loginSchema, refreshSchema } from "./auth.schema.js";
import * as authService from "./auth.service.js";

export default async function authRoutes(fastify: FastifyInstance) {
  fastify.post("/register", async (request, reply) => {
    const body = registerSchema.parse(request.body);
    const result = await authService.register(fastify, body);
    return reply.status(201).send(result);
  });

  fastify.post("/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const result = await authService.login(fastify, body);
    return reply.send(result);
  });

  fastify.post("/refresh", async (request, reply) => {
    const body = refreshSchema.parse(request.body);
    const result = await authService.refresh(fastify, body.refreshToken);
    return reply.send(result);
  });

  fastify.post(
    "/logout",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      await authService.logout(fastify, request.user.sub);
      return reply.send({ message: "Logged out" });
    }
  );
}
