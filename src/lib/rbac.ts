import type { FastifyRequest, FastifyReply } from "fastify";
import type { Role } from "@prisma/client";

export function requireRole(...roles: Role[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.unauthorized("Authentication required");
    }
    if (!roles.includes(request.user.role as Role)) {
      return reply.forbidden("Insufficient permissions");
    }
  };
}
