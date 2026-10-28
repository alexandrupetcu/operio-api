import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Tipurile de proiect de bază ale fiecărei firme. Dosarele (Carte Branșament /
 * Conductă / ISCIR) și asistentul de proiect le caută după `code`, deci orice firmă
 * trebuie să le aibă — nu doar cea din seed. Aceeași listă e în migrarea
 * `20261021090000_default_project_types` (firmele existente).
 */
// Fără „Revizie Centrală”: reviziile se fac din Programări / Revizii, nu ca proiecte (scos 28.10.2026).
export const DEFAULT_PROJECT_TYPES = [
  { code: "bransament", name: "Branșament Gaz", description: "Proiecte de branșament la rețeaua de gaze naturale" },
  { code: "conducta", name: "Extindere Conductă", description: "Proiecte de extindere a conductei de gaze" },
  { code: "dosar_iscir", name: "Dosar ISCIR", description: "Dosare pentru inspecții ISCIR" },
] as const;

/** Creează tipurile lipsă; cele existente (și eventual redenumite de firmă) rămân neatinse. */
export async function ensureDefaultProjectTypes(db: PrismaClient | Prisma.TransactionClient, tenantId: string) {
  await db.projectType.createMany({
    data: DEFAULT_PROJECT_TYPES.map((t) => ({ tenantId, ...t })),
    skipDuplicates: true,
  });
}
