/**
 * Seed the "Dosar Bransament NEOGAS GRID" DOCX group (category CARTE_BRANSAMENT)
 * from the templatized .docx files in `documente/Carte constructie bransament
 * GN NEOGAS GRID S.A./`.
 *
 * 29-member dossier (NEOGAS uses a much richer document set than Distrigaz or
 * MegaConstruct — proba presiune, faza determinanta, sudori tables, etc.).
 *
 * Mirrors `seed-bransament-template-group.ts` structure including NFC unicode
 * normalization to prevent duplicate creation on macOS round-trips.
 *
 * Run: npx tsx --env-file=.env scripts/seed-neogas-bransament-template-group.ts
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync, readdirSync } from "fs";
import { join, basename, extname } from "path";
import { uploadFile, ensureBucket, deleteFile } from "../src/lib/s3.js";

const prisma = new PrismaClient();

const CATEGORY_CODE = "CARTE_BRANSAMENT";
const GROUP_NAME = "Dosar Bransament NEOGAS GRID";
const FOLDER = join(process.cwd(), "..", "documente", "Carte constructie bransament GN NEOGAS GRID S.A.");
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
      name: "Carte Branșament",
      description: "Documente pentru dosarul de carte branșament gaze naturale",
      icon: "FolderOpen",
      color: "amber",
      isActive: true,
      sortOrder: 10,
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
        description: "Pachet de documente pentru dosarul de branșament NEOGAS GRID (fosta Premier Energy)",
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
    .sort((a, b) => {
      const numOf = (s: string) => {
        const m = s.match(/^(\d+)(?:\.\s*(\d+))?/);
        if (!m) return [Number.MAX_SAFE_INTEGER, 0] as const;
        return [parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0] as const;
      };
      const [an, asub] = numOf(a);
      const [bn, bsub] = numOf(b);
      if (an !== bn) return an - bn;
      if (asub !== bsub) return asub - bsub;
      return a.localeCompare(b);
    });

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
