import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Distribuitorii (OSD) pentru care există seturi de dosare. Workflow-urile generale și
 * generarea „setul distribuitorului” îi caută după `code`, deci orice firmă îi primește
 * (numele legal, cum apare pe documente; adresa/telefonul le completează firma în
 * Setări → Distribuitori). Aceeași listă e în migrarea `…_default_distributors`.
 */
export const DEFAULT_DISTRIBUTORS = [
  { code: "DISTRIGAZ", name: "Distrigaz Sud Rețele S.R.L." },
  { code: "NEOGAS_GRID", name: "Neogas Grid S.A." },
  { code: "MEGACONSTRUCT", name: "Megaconstruct S.A." },
] as const;

/** Creează distribuitorii lipsă; cei existenți (eventual redenumiți, cu contact) rămân neatinși. */
export async function ensureDefaultDistributors(db: PrismaClient | Prisma.TransactionClient, tenantId: string) {
  await db.distributor.createMany({
    data: DEFAULT_DISTRIBUTORS.map((d) => ({ tenantId, ...d })),
    skipDuplicates: true,
  });
}
