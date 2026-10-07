/**
 * Import a bundle from scripts/export-workflows.ts into this environment.
 * Tenant-scoped rows (project types, distributors, tenant workflows and their
 * steps) are re-homed onto --tenant <slug>; global definitions stay global.
 * `createdById` is dropped (users differ per environment). Upserts by id —
 * idempotent, re-run to refresh.
 *
 *   docker compose exec api npx tsx scripts/import-workflows.ts /bundle --tenant operio
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const prisma = new PrismaClient();
const dir = process.argv[2];
const tenantFlag = process.argv.indexOf("--tenant");
const tenantSlug = tenantFlag > -1 ? process.argv[tenantFlag + 1] : null;
if (!dir || !tenantSlug) {
  console.error("usage: import-workflows.ts <bundle-dir> --tenant <slug>");
  process.exit(1);
}

type Row = Record<string, any>;
const strip = ({ id, createdAt, updatedAt, ...rest }: Row) => ({ id, data: rest });

async function main() {
  const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug! } });
  if (!tenant) throw new Error(`tenant '${tenantSlug}' not found`);
  const bundle = JSON.parse(readFileSync(join(dir, "workflows.json"), "utf-8"));

  for (const row of bundle.projectTypes as Row[]) {
    const { id, data } = strip(row);
    const d = { ...data, tenantId: tenant.id };
    await prisma.projectType.upsert({ where: { id }, update: d, create: { id, ...d } });
  }
  for (const row of bundle.distributors as Row[]) {
    const { id, data } = strip(row);
    const d = { ...data, tenantId: tenant.id };
    await prisma.distributor.upsert({ where: { id }, update: d, create: { id, ...d } });
  }

  // Base definitions before derived ones (self-referencing FK).
  const defs = [...(bundle.definitions as Row[])].sort((a, b) => Number(!!a.baseDefinitionId) - Number(!!b.baseDefinitionId));
  let steps = 0, transitions = 0, actions = 0;
  for (const def of defs) {
    const { steps: defSteps, transitions: defTransitions, ...defRow } = def;
    const scope = (tid: string | null) => (tid ? tenant.id : null);
    const { id, data } = strip(defRow);
    const d = { ...data, tenantId: scope(data.tenantId), createdById: null };
    await prisma.workflowDefinition.upsert({ where: { id }, update: d, create: { id, ...d } });

    for (const step of defSteps as Row[]) {
      const { actions: stepActions, ...stepRow } = step;
      const s = strip(stepRow);
      const sd = { ...s.data, tenantId: scope(s.data.tenantId) };
      await prisma.workflowStep.upsert({ where: { id: s.id }, update: sd, create: { id: s.id, ...sd } });
      steps++;
      for (const action of stepActions as Row[]) {
        const a = strip(action);
        const ad = { ...a.data, tenantId: scope(a.data.tenantId) };
        await prisma.workflowStepAction.upsert({ where: { id: a.id }, update: ad, create: { id: a.id, ...ad } });
        actions++;
      }
    }
    for (const tr of defTransitions as Row[]) {
      const t = strip(tr);
      const td = { ...t.data, tenantId: scope(t.data.tenantId) };
      await prisma.workflowTransition.upsert({ where: { id: t.id }, update: td, create: { id: t.id, ...td } });
      transitions++;
    }
    console.log(`  ~ ${def.name} v${def.version} [${def.status}] ${d.tenantId ? "tenant" : "GLOBAL"}`);
  }
  console.log(
    `imported ${bundle.projectTypes.length} project types, ${bundle.distributors.length} distributors, ${defs.length} definitions, ${steps} steps, ${transitions} transitions, ${actions} actions → tenant '${tenantSlug}'`,
  );
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
