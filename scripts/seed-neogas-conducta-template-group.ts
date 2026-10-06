/**
 * Seed the "Dosar Conducta NEOGAS GRID" DOCX group (category CARTE_CONDUCTA)
 * from the templatized .docx file in `documente/Carte Conducta Neogas Grid/`.
 *
 * Single-member group — NEOGAS conducta uses one combined "Carte tehnică"
 * document instead of the multi-file dossier other OSDs use. Wrapping it in
 * a group anyway (rather than as a standalone template) keeps the UX uniform
 * — users always pick a "group" via the quick-dossier wizard — and leaves
 * room to add more members later if NEOGAS publishes additional forms.
 *
 * Run: npx tsx --env-file=.env scripts/seed-neogas-conducta-template-group.ts
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync, readdirSync } from "fs";
import { join, basename, extname } from "path";
import { uploadFile, ensureBucket, deleteFile } from "../src/lib/s3.js";

const prisma = new PrismaClient();

const CATEGORY_CODE = "CARTE_CONDUCTA";
const GROUP_NAME = "Dosar Conducta NEOGAS GRID";
const FOLDER = join(process.cwd(), "..", "documente", "Carte Conducta Neogas Grid");
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function cleanName(file: string): string {
  return basename(file, extname(file))
    .replace(/^\d+(\.\s*\d+)*[.\)]*[\s_]*/, "")
    .replace(/\(x\d+\)/i, "")
    .replace(/_+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  await ensureBucket();

  await prisma.templateCategory.upsert({
    where: { code: CATEGORY_CODE },
    update: {},
    create: {
      code: CATEGORY_CODE,
      name: "Carte Conductă",
      description: "Documente pentru dosarul de carte conductă gaze naturale",
      icon: "FolderOpen",
      color: "amber",
      isActive: true,
      sortOrder: 11,
    },
  });

  let group = await prisma.documentTemplate.findFirst({
    where: { tenantId: null, categoryCode: CATEGORY_CODE, type: "group", name: GROUP_NAME },
  });
  if (!group) {
    group = await prisma.documentTemplate.create({
      data: {
        tenantId: null,
        categoryCode: CATEGORY_CODE,
        name: GROUP_NAME,
        description: "Carte tehnică conductă NEOGAS GRID (fosta Premier Energy)",
        type: "group",
        isActive: true,
      },
    });
    console.log(`Created group: ${group.id}`);
  } else {
    console.log(`Group exists: ${group.id}`);
  }

  const files = readdirSync(FOLDER)
    .filter((f) => f.toLowerCase().endsWith(".docx") && !f.startsWith("~$") && !f.startsWith("_"))
    .sort((a, b) => a.localeCompare(b));

  const last = await prisma.documentTemplate.findFirst({
    where: { parentGroupId: group.id },
    orderBy: { memberOrder: "desc" },
    select: { memberOrder: true },
  });
  let order = (last?.memberOrder ?? -1) + 1;

  const BUILD_PREFIX = `templates/${CATEGORY_CODE}/`;
  const nfc = (s: string) => s.normalize("NFC");
  for (const rawFile of files) {
    const file = nfc(rawFile);
    const name = nfc(cleanName(rawFile));

    const candidates = await prisma.documentTemplate.findMany({
      where: { parentGroupId: group.id },
      select: { id: true, name: true, description: true, s3Key: true },
    });
    const exists =
      candidates.find((c) => c.description && nfc(c.description) === file) ??
      candidates.find((c) => nfc(c.name) === name);

    if (exists?.s3Key && !exists.s3Key.startsWith(BUILD_PREFIX) && !process.env.FORCE_REFRESH) {
      console.log(`  ⚠ skipped (edited in-app, not overwritten): ${name} — set FORCE_REFRESH=1 to overwrite`);
      continue;
    }

    const buffer = readFileSync(join(FOLDER, rawFile));
    const s3Key = `${BUILD_PREFIX}${Date.now()}-${file}`;
    await uploadFile(s3Key, buffer, DOCX_MIME);

    if (exists) {
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

  console.log(`\nDone. ${files.length} files processed.`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
