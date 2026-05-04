import type { FastifyRequest, FastifyReply } from "fastify";
import type { Role } from "@prisma/client";

export function requireRole(...roles: Role[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.unauthorized("Authentication required");
    }
    // MASTER_ADMIN has access to everything
    if (request.user.role === "MASTER_ADMIN") return;
    if (!roles.includes(request.user.role as Role)) {
      return reply.forbidden("Insufficient permissions");
    }
  };
}

export function requireMasterAdmin() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.unauthorized("Authentication required");
    }
    if (request.user.role !== "MASTER_ADMIN") {
      return reply.forbidden("Master admin access required");
    }
  };
}
