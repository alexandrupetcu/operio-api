/**
 * Delete the pre-templatization Anexa A/B entries that became duplicates after
 * the latest seed run. The unicode-normalization mismatch (NFD on macOS disk
 * vs NFC stored in Postgres) caused the seed's description lookup to miss the
 * existing entries — see `inspect-conducta-group.ts` output for the hex proof.
 *
 * Identifies victims by: same name + earliest createdAt (so we keep the newer
 * record which has the latest file content).
 */
import { PrismaClient } from "@prisma/client";
import { deleteFile } from "../src/lib/s3.js";

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN === "1";

async function main() {
  const g = await prisma.documentTemplate.findFirst({
    where: { categoryCode: "CARTE_CONDUCTA", type: "group", name: "Dosar Conducta Distrigaz", tenantId: null },
  });
  if (!g) return;

  // Group members by name → keep the newest, delete older duplicates.
  const all = await prisma.documentTemplate.findMany({
    where: { parentGroupId: g.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, description: true, memberOrder: true, s3Key: true, createdAt: true },
  });
  // Normalize to NFC so visually-identical names group together even when their
  // stored bytes differ (NFD on macOS filesystem vs NFC in Postgres after
  // round-trip through Python script that re-encoded the XML).
  const byName = new Map<string, typeof all>();
  for (const m of all) {
    const key = m.name.normalize("NFC");
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(m);
  }

  const victims = [];
  for (const [name, list] of byName) {
    if (list.length <= 1) continue;
    // Sorted desc by createdAt → list[0] is newest. Delete the rest.
    for (const v of list.slice(1)) {
      victims.push({ name, v });
    }
  }

  console.log(`Group: ${g.name} (${g.id})`);
  console.log(`Total members: ${all.length}`);
  console.log(`Duplicates to delete: ${victims.length}`);
  console.log(DRY_RUN ? "\n── DRY RUN ──\n" : "\n── Deleting ──\n");

  for (const { name, v } of victims) {
    console.log(`  "${name}" — keeping newest, deleting:`);
    console.log(`    id=${v.id}  order=${v.memberOrder}  created=${v.createdAt.toISOString()}`);
    if (DRY_RUN) continue;
    if (v.s3Key) {
      try { await deleteFile(v.s3Key); } catch (e) { console.log(`    s3 delete failed: ${(e as Error).message}`); }
    }
    await prisma.documentTemplate.delete({ where: { id: v.id } });
    console.log(`    ✓ deleted`);
  }

  const remaining = await prisma.documentTemplate.count({ where: { parentGroupId: g.id } });
  console.log(`\nMembers remaining: ${remaining}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
