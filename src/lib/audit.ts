import type { FastifyInstance } from "fastify";
import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Log an audit entry. Can be called with either a FastifyInstance or a raw PrismaClient.
 */
export async function logAudit(
  prismaOrFastify: PrismaClient | FastifyInstance,
  tenantId: string,
  actorUserId: string | null,
  entityType: string,
  entityId: string,
  action: string,
  before?: unknown,
  after?: unknown,
  ipAddress?: string
): Promise<void> {
  const prisma =
    "prisma" in prismaOrFastify
      ? (prismaOrFastify as FastifyInstance).prisma
      : (prismaOrFastify as PrismaClient);

  await prisma.auditLog.create({
    data: {
      tenantId,
      actorUserId,
      entityType,
      entityId,
      action,
      beforeJson: before as Prisma.InputJsonValue | undefined,
      afterJson: after as Prisma.InputJsonValue | undefined,
      metadataJson: ipAddress
        ? ({ ipAddress } as Prisma.InputJsonValue)
        : undefined,
    },
  });
}
