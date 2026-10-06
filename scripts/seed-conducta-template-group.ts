/**
 * Seed the "Dosar Conducta Distrigaz" DOCX group (category CARTE_CONDUCTA)
 * from the templatized .docx files in `documente/Carte Conducta Distrigaz/`.
 *
 * Mirrors `seed-bransament-template-group.ts` exactly — same idempotency rules,
 * same FORCE_REFRESH guard, same numeric-aware sort.
 *
 * Run: npx tsx --env-file=.env scripts/seed-conducta-template-group.ts
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync, readdirSync } from "fs";
import { join, basename, extname } from "path";
import { uploadFile, ensureBucket, deleteFile } from "../src/lib/s3.js";

const prisma = new PrismaClient();

const CATEGORY_CODE = "CARTE_CONDUCTA";
const GROUP_NAME = "Dosar Conducta Distrigaz";
const FOLDER = join(process.cwd(), "..", "documente", "Carte Conducta Distrigaz");
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function cleanName(file: string): string {
  return basename(file, extname(file))
    .replace(/^\d+(\.\d+)?[.\)]*[\s_]*/, "") // strip "1.", "3.1)", "20) ", "25)", "26.", etc.
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
        description: "Pachet complet de documente pentru dosarul de conductă Distrigaz (extindere RP)",
        type: "group",
        isActive: true,
      },
    });
    console.log(`Created group: ${group.id}`);
  } else {
    console.log(`Group exists: ${group.id}`);
  }

  // Backup folders / hidden files are skipped. Sort numerically so "10." comes
  // after "2.", "6.1." sits right after "6.", etc.
  const files = readdirSync(FOLDER)
    .filter((f) => f.toLowerCase().endsWith(".docx") && !f.startsWith("~$") && !f.startsWith("_"))
    .sort((a, b) => {
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
  // macOS gives filenames in NFD form (e.g. "ă" = "a" + combining breve), but
  // strings from previous seed runs may have been stored in NFC. Normalize both
  // sides to NFC so the description lookup doesn't miss an existing entry just
  // because the bytes differ visually-identically.
  const nfc = (s: string) => s.normalize("NFC");
  for (const rawFile of files) {
    const file = nfc(rawFile);
    const name = nfc(cleanName(rawFile));

    // First try by description (stable across renames). Match all rows and
    // compare normalized, because Postgres `equals` is byte-exact.
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

    // Read the file using the OS-native (rawFile, possibly NFD on macOS) form;
    // store paths + DB fields in NFC.
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
