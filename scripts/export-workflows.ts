/**
 * Export the catalog a firm needs to run projects — project types, distributors
 * and workflow definitions (steps, transitions, step actions) — so it can be
 * carried from dev to production with ids intact (definitions reference the
 * project type / distributor by id; templates were imported with their ids too).
 *
 *   npx tsx --env-file=.env scripts/export-workflows.ts <out-dir> --tenant <slug>
 *
 * Takes the tenant's project types + distributors and every non-archived,
 * non-empty workflow definition that is global or belongs to that tenant.
 * Import with scripts/import-workflows.ts.
 */
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const prisma = new PrismaClient();
const outDir = process.argv[2];
const tenantFlag = process.argv.indexOf("--tenant");
const tenantSlug = tenantFlag > -1 ? process.argv[tenantFlag + 1] : null;
if (!outDir || !tenantSlug) {
  console.error("usage: export-workflows.ts <out-dir> --tenant <slug>");
  process.exit(1);
}

async function main() {
  const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug! } });
  if (!tenant) throw new Error(`tenant '${tenantSlug}' not found`);

  const projectTypes = await prisma.projectType.findMany({ where: { tenantId: tenant.id } });
  const distributors = await prisma.distributor.findMany({ where: { tenantId: tenant.id } });
  const definitions = await prisma.workflowDefinition.findMany({
    where: { OR: [{ tenantId: null }, { tenantId: tenant.id }], status: { not: "archived" }, steps: { some: {} } },
    include: { steps: { include: { actions: true } }, transitions: true },
  });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "workflows.json"),
    JSON.stringify({ exportedAt: new Date().toISOString(), sourceTenant: tenantSlug, projectTypes, distributors, definitions }, null, 2),
  );
  const steps = definitions.reduce((n, d) => n + d.steps.length, 0);
  console.log(
    `exported ${projectTypes.length} project types, ${distributors.length} distributors, ${definitions.length} workflow definitions (${steps} steps) → ${outDir}`,
  );
  for (const d of definitions) console.log(`  - ${d.name} v${d.version} [${d.status}] ${d.tenantId ? "tenant" : "GLOBAL"}`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
