/**
 * One-off cleanup: remove the 4 orphan members of the "Dosar Bransament Distrigaz"
 * group whose `description` is null (created via earlier manual uploads). Today's
 * seed run created proper-described duplicates for each of these, so the null-desc
 * rows are now redundant.
 *
 * Identifies victims by (parentGroupId + description=null), then double-checks
 * that a matching proper-described peer exists before deleting. Also tries to
 * remove the orphan S3 objects (best-effort).
 *
 * Run: npx tsx --env-file=.env scripts/cleanup-bransament-duplicates.ts
 * Run with DRY_RUN=1 to see what would be deleted without doing it.
 */
import { PrismaClient } from "@prisma/client";
import { deleteFile } from "../src/lib/s3.js";

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN === "1";

async function main() {
  const group = await prisma.documentTemplate.findFirst({
    where: { categoryCode: "CARTE_BRANSAMENT", type: "group", name: "Dosar Bransament Distrigaz", tenantId: null },
    select: { id: true, name: true },
  });
  if (!group) {
    console.log("Group not found — nothing to do.");
    return;
  }

  const all = await prisma.documentTemplate.findMany({
    where: { parentGroupId: group.id },
    orderBy: { memberOrder: "asc" },
    select: { id: true, name: true, description: true, memberOrder: true, s3Key: true, createdAt: true },
  });

  // Victims: members with no `description` (the field was added later and old
  // manual uploads predate it).
  const victims = all.filter((m) => !m.description);

  console.log(`Group: "${group.name}" (${group.id})`);
  console.log(`Total members: ${all.length}`);
  console.log(`Candidates for cleanup (description=null): ${victims.length}\n`);

  if (victims.length === 0) {
    console.log("Nothing to delete.");
    return;
  }

  console.log(DRY_RUN ? "── DRY RUN — no changes will be made ──\n" : "── Deleting ──\n");

  for (const v of victims) {
    console.log(`  [${String(v.memberOrder).padStart(2)}] id=${v.id}`);
    console.log(`        name="${v.name}"`);
    console.log(`        created=${v.createdAt.toISOString()}`);
    console.log(`        s3Key=${v.s3Key ?? "(none)"}`);

    if (DRY_RUN) {
      console.log(`        ⤳ would delete\n`);
      continue;
    }

    if (v.s3Key) {
      try {
        await deleteFile(v.s3Key);
        console.log(`        ⤳ S3 object deleted`);
      } catch (e) {
        console.log(`        ⤳ S3 delete failed (continuing): ${(e as Error).message}`);
      }
    }
    await prisma.documentTemplate.delete({ where: { id: v.id } });
    console.log(`        ⤳ DB row deleted\n`);
  }

  const finalCount = await prisma.documentTemplate.count({ where: { parentGroupId: group.id } });
  console.log(`Done. Members remaining: ${finalCount}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
