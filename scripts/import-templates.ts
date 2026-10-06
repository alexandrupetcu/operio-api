/**
 * Import a bundle produced by scripts/export-templates.ts: uploads the files to
 * this environment's S3 bucket (same keys) and upserts categories + templates
 * by id. Idempotent — re-running refreshes content/files in place.
 *
 *   docker compose exec api npx tsx scripts/import-templates.ts /path/to/bundle
 *   (locally: npx tsx --env-file=.env scripts/import-templates.ts <bundle-dir>)
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { uploadFile } from "../src/lib/s3.js";

const prisma = new PrismaClient();
const dir = process.argv[2];
if (!dir) {
  console.error("usage: import-templates.ts <bundle-dir>");
  process.exit(1);
}

type Bundle = {
  categories: Array<Record<string, any>>;
  templates: Array<Record<string, any>>;
};

async function main() {
  const bundle: Bundle = JSON.parse(readFileSync(join(dir, "templates.json"), "utf-8"));

  for (const { id, createdAt, updatedAt, ...c } of bundle.categories) {
    await prisma.templateCategory.upsert({ where: { code: c.code }, update: c, create: { id, ...c } });
  }

  // Parents before members: parentGroupId is a FK onto the same table.
  const ordered = [...bundle.templates].sort((a, b) => Number(!!a.parentGroupId) - Number(!!b.parentGroupId));
  let files = 0;
  for (const { id, createdAt, updatedAt, ...t } of ordered) {
    if (t.s3Key) {
      const buf = readFileSync(join(dir, "files", t.s3Key));
      await uploadFile(t.s3Key, buf, contentTypeFor(t.s3Key));
      files++;
    }
    await prisma.documentTemplate.upsert({ where: { id }, update: t, create: { id, ...t } });
  }
  console.log(`imported ${bundle.categories.length} categories, ${ordered.length} templates, ${files} files`);
}

function contentTypeFor(key: string): string {
  if (key.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (key.endsWith(".pdf")) return "application/pdf";
  if (key.endsWith(".html")) return "text/html";
  return "application/octet-stream";
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
