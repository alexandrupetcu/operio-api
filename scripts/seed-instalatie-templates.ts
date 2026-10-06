/**
 * Seed the HTML document templates for the "Revizie instalație" and
 * "Verificare instalație" appointment types. Each generated document is its own
 * TemplateCategory (so finalize's lookup by categoryCode is unambiguous). The
 * HTML lives in scripts/instalatie-templates/*.html (faithful recreations of the
 * Word/PDF sources, with {{variable}} placeholders precomputed by the worker's
 * buildInstalatieReportData). Global templates (tenantId: null).
 *
 * Idempotent. Run: npx tsx --env-file=.env scripts/seed-instalatie-templates.ts
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "scripts", "instalatie-templates");

const TEMPLATES = [
  { code: "REVIZIE_INSTALATIE_RT", name: "Fișă revizie tehnică instalație (RT)", file: "rt.html", catName: "Revizie instalație — Fișă RT", icon: "ClipboardCheck", color: "blue", sort: 30 },
  { code: "REVIZIE_INSTALATIE_PV", name: "PV recepție tehnică instalație", file: "pv.html", catName: "Revizie instalație — PV recepție", icon: "FileCheck", color: "blue", sort: 31 },
  { code: "REVIZIE_INSTALATIE_BULETIN", name: "Buletin de sigilare/desigilare", file: "buletin.html", catName: "Revizie instalație — Buletin sigilare", icon: "Stamp", color: "amber", sort: 32 },
  { code: "CONTRACT_REVIZIE_INSTALATIE", name: "Contract revizie instalație", file: "contract-revizie.html", catName: "Contract revizie instalație", icon: "FileSignature", color: "cyan", sort: 33 },
  { code: "VERIFICARE_INSTALATIE_FISA", name: "Fișă verificare tehnică instalație", file: "fisa.html", catName: "Verificare instalație — Fișă", icon: "ShieldCheck", color: "blue", sort: 34 },
  { code: "CONTRACT_VERIFICARE_INSTALATIE", name: "Contract verificare instalație", file: "contract-verificare.html", catName: "Contract verificare instalație", icon: "FileSignature", color: "cyan", sort: 35 },
];

export async function seedInstalatieTemplates(prisma: PrismaClient) {
  for (const t of TEMPLATES) {
    await prisma.templateCategory.upsert({
      where: { code: t.code },
      update: { name: t.catName },
      create: {
        code: t.code,
        name: t.catName,
        description: t.name,
        icon: t.icon,
        color: t.color,
        isActive: true,
        sortOrder: t.sort,
      },
    });

    const content = readFileSync(join(DIR, t.file), "utf-8");
    const existing = await prisma.documentTemplate.findFirst({
      where: { tenantId: null, categoryCode: t.code, name: t.name },
    });
    if (existing) {
      await prisma.documentTemplate.update({ where: { id: existing.id }, data: { content, isActive: true } });
      console.log(`  ~ refreshed: ${t.code}`);
    } else {
      await prisma.documentTemplate.create({
        data: { tenantId: null, categoryCode: t.code, name: t.name, content, sortOrder: 1, isActive: true },
      });
      console.log(`  + created: ${t.code}`);
    }
  }
  console.log("\nDone.");
}

// Only run when executed directly (seed-production.ts imports the function).
if (process.argv[1] && process.argv[1].includes("seed-instalatie-templates")) {
  const prisma = new PrismaClient();
  seedInstalatieTemplates(prisma)
    .catch((err) => { console.error(err); process.exit(1); })
    .finally(() => prisma.$disconnect());
}
