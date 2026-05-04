import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { requireRole } from "../../lib/rbac.js";
import { paginationSchema, paginationArgs, paginationMeta } from "../../lib/pagination.js";

export default async function auditRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get(
    "/",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      const query = paginationSchema.parse(request.query);
      const { entityType, entityId, action, actorUserId, dateFrom, dateTo } =
        request.query as Record<string, string>;

      const where: Prisma.AuditLogWhereInput = {
        tenantId: request.tenantId,
        ...(entityType && { entityType }),
        ...(entityId && { entityId }),
        ...(action && { action }),
        ...(actorUserId && { actorUserId }),
        ...((dateFrom || dateTo) && {
          createdAt: {
            ...(dateFrom && { gte: new Date(dateFrom) }),
            ...(dateTo && { lte: new Date(dateTo) }),
          },
        }),
      };

      const [data, total] = await Promise.all([
        fastify.prisma.auditLog.findMany({
          where,
          include: {
            actorUser: {
              select: { id: true, firstName: true, lastName: true, email: true },
            },
          },
          ...paginationArgs(query),
        }),
        fastify.prisma.auditLog.count({ where }),
      ]);

      return { data, ...paginationMeta(total, query) };
    }
  );
}
