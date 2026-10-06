/**
 * Seed the "Dosar Bransament Distrigaz" DOCX group (category CARTE_BRANSAMENT)
 * from the templatized .docx files in `documente/Carte Bransament Templates/`.
 *
 * Creates a parent DocumentTemplate (type:"group") + one ordered member
 * (type:"single", parentGroupId) per .docx, uploading each to S3. Idempotent:
 * re-running matches existing members by stable original filename and refreshes
 * the S3 object in place; in-app edits (s3Key outside the build prefix) are
 * skipped unless FORCE_REFRESH=1.
 *
 * `CARTE_BRANSAMENT_COMPLET.docx` is the merged-preview document (union of all
 * placeholders) and is intentionally excluded — it would duplicate the bundle.
 *
 * Run: npx tsx --env-file=.env scripts/seed-bransament-template-group.ts
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync, readdirSync } from "fs";
import { join, basename, extname } from "path";
import { uploadFile, ensureBucket, deleteFile } from "../src/lib/s3.js";

const prisma = new PrismaClient();

const CATEGORY_CODE = "CARTE_BRANSAMENT";
const GROUP_NAME = "Dosar Bransament Distrigaz";
const FOLDER = join(process.cwd(), "..", "documente", "Carte Bransament Templates");
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Files to exclude from the group — the COMPLET preview is the union of all
// placeholders in the other 25 templates and would just produce a duplicate.
const EXCLUDE = new Set(["CARTE_BRANSAMENT_COMPLET.docx"]);

function cleanName(file: string): string {
  return basename(file, extname(file))
    .replace(/^\d+(\.\d+)?[.\)]?[\s_]*/, "") // leading "1.", "3.1)", "20) ", "25 ", etc.
    .replace(/\(x\d+\)/i, "")
    .replace(/_+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  await ensureBucket();

  // 1. Category — reuse the existing CARTE_BRANSAMENT category (seeded by
  // seed-document-templates.ts). upsert keeps this script self-contained if
  // someone runs it on a fresh DB.
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

  // 2. Parent group (global / tenantId null).
  let group = await prisma.documentTemplate.findFirst({
    where: { tenantId: null, categoryCode: CATEGORY_CODE, type: "group", name: GROUP_NAME },
  });
  if (!group) {
    group = await prisma.documentTemplate.create({
      data: {
        tenantId: null,
        categoryCode: CATEGORY_CODE,
        name: GROUP_NAME,
        description: "Pachet complet de documente pentru dosarul de branșament Distrigaz",
        type: "group",
        isActive: true,
      },
    });
    console.log(`Created group: ${group.id}`);
  } else {
    console.log(`Group exists: ${group.id}`);
  }

  // 3. Members.
  const files = readdirSync(FOLDER)
    .filter((f) => f.toLowerCase().endsWith(".docx") && !f.startsWith("~$") && !EXCLUDE.has(f))
    .sort((a, b) => {
      // Numeric-aware sort so "10.) …" comes after "2.) …" (default lex sort
      // would put 10 before 2). Extracts the leading number, falls back to
      // string compare for ties.
      const numOf = (s: string) => {
        const m = s.match(/^(\d+)(?:\.(\d+))?/);
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
  // macOS gives filenames in NFD (e.g. "ă" = "a" + combining breve). Files
  // round-tripped through Python scripts come back as NFC. Postgres `equals`
  // is byte-exact, so the description/name lookup misses cross-form duplicates
  // unless we normalize both sides.
  const nfc = (s: string) => s.normalize("NFC");
  for (const rawFile of files) {
    const file = nfc(rawFile);
    const name = nfc(cleanName(rawFile));

    // Match on the stable original filename (stored in `description`) first, so
    // a member renamed in-app isn't missed → duplicated. Fall back to `name`.
    const candidates = await prisma.documentTemplate.findMany({
      where: { parentGroupId: group.id },
      select: { id: true, name: true, description: true, s3Key: true },
    });
    const exists =
      candidates.find((c) => c.description && nfc(c.description) === file) ??
      candidates.find((c) => nfc(c.name) === name);

    // Guard: never silently clobber a member edited in-app — its file lives
    // outside the build prefix (e.g. templates/system/…). Require FORCE_REFRESH.
    if (exists?.s3Key && !exists.s3Key.startsWith(BUILD_PREFIX) && !process.env.FORCE_REFRESH) {
      console.log(`  ⚠ skipped (edited in-app, not overwritten): ${name} — set FORCE_REFRESH=1 to overwrite`);
      continue;
    }

    // Read using the OS-native (rawFile) form so macOS finds the file; store
    // paths/DB fields in NFC.
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

  console.log(`\nDone. ${files.length} files processed (excluded: ${[...EXCLUDE].join(", ")})`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
