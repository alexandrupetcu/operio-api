import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { requireRole } from "../../lib/rbac.js";
import { paginationSchemaFor, paginationArgs, paginationMeta } from "../../lib/pagination.js";

/** Columns the audit log may be sorted by (AuditLog has no `updatedAt`). */
export const AUDIT_SORTABLE = ["createdAt", "action", "entityType"] as const;

const listQuerySchema = paginationSchemaFor(AUDIT_SORTABLE);

export default async function auditRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get(
    "/",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      const query = listQuerySchema.parse(request.query);
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
          ...paginationArgs(query, AUDIT_SORTABLE),
        }),
        fastify.prisma.auditLog.count({ where }),
      ]);

      return { data, ...paginationMeta(total, query) };
    }
  );
}
