import type { PrismaClient } from "@prisma/client";
import { TtlCache } from "./ttl-cache.js";

/**
 * Legătura cont → angajat (Employee.userId), citită la fiecare cerere a unui tehnician
 * pentru vizibilitatea programărilor. Se schimbă doar din setări (legare / dezlegare) sau
 * la auto-creare la login — acolo se invalidează explicit.
 */
const cache = new TtlCache<string | null>(60_000);
const keyOf = (tenantId: string, userId: string) => `${tenantId}:${userId}`;

export async function cachedEmployeeId(prisma: PrismaClient, tenantId: string, userId: string): Promise<string | null> {
  return cache.getOrLoad(keyOf(tenantId, userId), async () => {
    const row = await prisma.employee.findFirst({ where: { userId, tenantId }, select: { id: true } });
    return row?.id ?? null;
  });
}

export function invalidateEmployeeLink(tenantId: string, userId: string): void {
  cache.delete(keyOf(tenantId, userId));
}
