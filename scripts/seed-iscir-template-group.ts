/**
 * Seed the "Dosar ISCIR Template" DOCX group (category DOSAR_ISCIR) from the
 * templatized .docx files in `documente/Dosar ISCIR Template/`.
 *
 * Creates a parent DocumentTemplate (type:"group") + one ordered member
 * (type:"single", parentGroupId) per .docx, uploading each to S3. Idempotent:
 * re-running skips existing members.
 *
 * Prereq: run `npx tsx scripts/build-iscir-templates.ts` first.
 * Run: npx tsx --env-file=.env scripts/seed-iscir-template-group.ts
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync, readdirSync } from "fs";
import { join, basename, extname } from "path";
import { uploadFile, ensureBucket, deleteFile } from "../src/lib/s3.js";

const prisma = new PrismaClient();

const CATEGORY_CODE = "DOSAR_ISCIR";
const GROUP_NAME = "Dosar ISCIR Template";
const FOLDER = join(process.cwd(), "..", "documente", "Dosar ISCIR Template");
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function cleanName(file: string): string {
  return basename(file, extname(file))
    .replace(/^\d+[.\)]?[\s_]*/, "") // leading "01 ", "8.", "0. "
    .replace(/\(x\d+\)/i, "")
    .replace(/_+$/, "")
    .trim();
}

async function main() {
  await ensureBucket();

  // 1. Category
  await prisma.templateCategory.upsert({
    where: { code: CATEGORY_CODE },
    update: {},
    create: {
      code: CATEGORY_CODE,
      name: "Dosar ISCIR",
      description: "Documente pentru dosarul ISCIR (procese verbale, decizii, convocare)",
      icon: "ShieldCheck",
      color: "blue",
      isActive: true,
      sortOrder: 12,
    },
  });

  // 2. Parent group (global / tenantId null)
  let group = await prisma.documentTemplate.findFirst({
    where: { tenantId: null, categoryCode: CATEGORY_CODE, type: "group", name: GROUP_NAME },
  });
  if (!group) {
    group = await prisma.documentTemplate.create({
      data: {
        tenantId: null,
        categoryCode: CATEGORY_CODE,
        name: GROUP_NAME,
        description: "Pachet de documente ISCIR generate din datele proiectului",
        type: "group",
        isActive: true,
      },
    });
    console.log(`Created group: ${group.id}`);
  } else {
    console.log(`Group exists: ${group.id}`);
  }

  // 3. Members
  const files = readdirSync(FOLDER)
    .filter((f) => f.toLowerCase().endsWith(".docx") && !f.startsWith("~$"))
    .sort();

  const last = await prisma.documentTemplate.findFirst({
    where: { parentGroupId: group.id },
    orderBy: { memberOrder: "desc" },
    select: { memberOrder: true },
  });
  let order = (last?.memberOrder ?? -1) + 1;

  const BUILD_PREFIX = `templates/${CATEGORY_CODE}/`;
  for (const file of files) {
    const name = cleanName(file);

    // Match on the stable original filename (stored in `description`) first, so a
    // member renamed in-app isn't missed → duplicated. Fall back to `name`.
    const exists =
      (await prisma.documentTemplate.findFirst({ where: { parentGroupId: group.id, description: file } })) ??
      (await prisma.documentTemplate.findFirst({ where: { parentGroupId: group.id, name } }));

    // Guard: never silently clobber a member edited in-app — its file lives
    // outside the build prefix (e.g. templates/system/…). Require FORCE_REFRESH.
    if (exists?.s3Key && !exists.s3Key.startsWith(BUILD_PREFIX) && !process.env.FORCE_REFRESH) {
      console.log(`  ⚠ skipped (edited in-app, not overwritten): ${name} — set FORCE_REFRESH=1 to overwrite`);
      continue;
    }

    const buffer = readFileSync(join(FOLDER, file));
    const s3Key = `${BUILD_PREFIX}${Date.now()}-${file}`;
    await uploadFile(s3Key, buffer, DOCX_MIME);

    if (exists) {
      // Refresh the member's file in place (push template changes), keep order.
      await prisma.documentTemplate.update({ where: { id: exists.id }, data: { s3Key, description: file } });
      if (exists.s3Key && exists.s3Key !== s3Key) {
        try { await deleteFile(exists.s3Key); } catch { /* best-effort */ }
      }
      console.log(`  ~ refreshed: ${name}`);
      continue;
    }
    await prisma.documentTemplate.create({
      data: {
        tenantId: null,
        categoryCode: CATEGORY_CODE,
        name,
        description: file,
        s3Key,
        type: "single",
        parentGroupId: group.id,
        memberOrder: order++,
        isActive: true,
      },
    });
    console.log(`  + [${order - 1}] ${name}`);
  }

  console.log("\nDone.");
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
