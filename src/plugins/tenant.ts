import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";

export default fp(async (fastify: FastifyInstance) => {
  fastify.decorateRequest("tenantId", "");
  fastify.decorateRequest("isMasterAdmin", false);

  fastify.addHook("preHandler", async (request: FastifyRequest) => {
    if (request.user?.role === "MASTER_ADMIN") {
      request.isMasterAdmin = true;
    }
    if (request.user?.tenantId) {
      request.tenantId = request.user.tenantId;
    }
  });
});

declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
    isMasterAdmin: boolean;
  }
}
