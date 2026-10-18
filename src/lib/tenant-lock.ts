import type { Prisma } from "@prisma/client";

/**
 * Blocaj consultativ (advisory) per tenant, ținut până la sfârșitul tranzacției
 * curente (`pg_advisory_xact_lock`). Serializează secvențele „citesc → decid →
 * scriu" care altfel s-ar întrece între două cereri ale aceleiași firme:
 * numărul de locuri de tehnician, crearea datelor de exemplu etc.
 *
 * Se apelează ca prima instrucțiune dintr-un `$transaction(async (tx) => …)`;
 * citirile de după el văd ce a scris tranzacția precedentă pe același tenant.
 * Cheia e `hashtext(tenantId)` (int4), deci firme diferite nu se blochează
 * reciproc (coliziunile de hash doar serializează în plus, nu strică nimic).
 */
export async function lockTenant(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
  await lockKey(tx, tenantId);
}

/** Același blocaj, pe o cheie oarecare (ex. id-ul unei programări, pentru idempotență). */
export async function lockKey(tx: Prisma.TransactionClient, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}
