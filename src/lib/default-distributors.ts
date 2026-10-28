import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * Distribuitorii (OSD) pentru care există seturi de dosare. Workflow-urile generale și
 * generarea „setul distribuitorului” îi caută după `code`, deci orice firmă îi primește:
 * numele legal și sediul central, cum apar pe documente (site-urile lor, 28.10.2026).
 * Firma le poate schimba în Setări → Distribuitori (ex. agenția / FOL-ul cu care lucrează).
 * Aceeași listă e în migrările `…_default_distributors` și `…_distributor_contacts`.
 */
export const DEFAULT_DISTRIBUTORS = [
  {
    code: "DISTRIGAZ",
    name: "Distrigaz Sud Rețele S.R.L.",
    // Fără fax public; 021 9376 = call center.
    contact: { address: "Bd. Mărășești nr. 4-6, Corp B", sector: "Sector 4", region: "București", phone: "021 9376" },
  },
  {
    code: "NEOGAS_GRID",
    name: "Neogas Grid S.A.",
    contact: {
      address: "Str. Grigore Alexandrescu nr. 89-97, Metropolis Building, Corp B, etaj Mezanin",
      sector: "Sector 1",
      region: "București",
      phone: "031.690.46.85",
      fax: "021.230.02.95",
    },
  },
  {
    code: "MEGACONSTRUCT",
    name: "Megaconstruct S.A.",
    contact: {
      address: "Piața Unirii nr. 1, Corp Central, etaj 5, Spațiul C5.02",
      sector: "Sector 3",
      region: "București",
      phone: "021.310.30.15",
      fax: "021.313.00.33",
    },
  },
] as const;

/**
 * Creează distribuitorii lipsă și pune datele de contact la cei care nu au niciunul;
 * numele și datele completate de firmă rămân neatinse.
 */
export async function ensureDefaultDistributors(db: PrismaClient | Prisma.TransactionClient, tenantId: string) {
  await db.distributor.createMany({
    data: DEFAULT_DISTRIBUTORS.map((d) => ({ tenantId, code: d.code, name: d.name, contactJson: d.contact })),
    skipDuplicates: true,
  });
  for (const d of DEFAULT_DISTRIBUTORS) {
    await db.distributor.updateMany({
      where: { tenantId, code: d.code, contactJson: { equals: Prisma.AnyNull } },
      data: { contactJson: d.contact },
    });
  }
}
