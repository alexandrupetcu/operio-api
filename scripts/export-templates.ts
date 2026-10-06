/**
 * Export document templates (DB rows + their S3 files) into a portable bundle
 * so they can be moved between environments (dev → production) exactly as they
 * are, ids included (group/member links depend on them).
 *
 *   npx tsx --env-file=.env scripts/export-templates.ts <out-dir> [--tenant <slug>]
 *
 * Default: global templates only (tenantId null) + every TemplateCategory.
 * --tenant <slug>: also include that tenant's templates, re-homed as GLOBAL
 * (tenantId null) so any firm registered in production can use them.
 * Import with scripts/import-templates.ts.
 */
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getFileBuffer } from "../src/lib/s3.js";

const prisma = new PrismaClient();
const outDir = process.argv[2];
const tenantFlag = process.argv.indexOf("--tenant");
const tenantSlug = tenantFlag > -1 ? process.argv[tenantFlag + 1] : null;
if (!outDir) {
  console.error("usage: export-templates.ts <out-dir> [--tenant <slug>]");
  process.exit(1);
}

async function main() {
  const categories = await prisma.templateCategory.findMany({ orderBy: { sortOrder: "asc" } });

  const where: { OR: object[] } = { OR: [{ tenantId: null }] };
  if (tenantSlug) {
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new Error(`tenant '${tenantSlug}' not found`);
    where.OR.push({ tenantId: tenant.id });
  }
  const rows = await prisma.documentTemplate.findMany({ where, orderBy: [{ parentGroupId: "asc" }, { memberOrder: "asc" }] });

  const templates = rows.map(({ tenantId, ...t }) => ({ ...t, tenantId: null as string | null }));

  mkdirSync(join(outDir, "files"), { recursive: true });
  let files = 0;
  for (const t of templates) {
    if (!t.s3Key) continue;
    const buf = await getFileBuffer(t.s3Key);
    const dest = join(outDir, "files", t.s3Key);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    files++;
  }
  writeFileSync(
    join(outDir, "templates.json"),
    JSON.stringify({ exportedAt: new Date().toISOString(), categories, templates }, null, 2),
  );
  console.log(`exported ${categories.length} categories, ${templates.length} templates, ${files} files → ${outDir}`);
  if (tenantSlug) console.log(`(tenant '${tenantSlug}' templates included as GLOBAL)`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
