/**
 * O singură dată (28.10.2026): documentele din grupurile de sistem de branșament și
 * conductă primesc ca nume de fișier (`fileName`) numele fișierului original al
 * clientului, reținut în `description` la încărcare — arhiva dosarului le folosește,
 * cu numerotarea după care se tipăresc. ISCIR și șabloanele firmelor nu se ating;
 * un nume de fișier dat deja în aplicație rămâne.
 *
 * Run: npx tsx scripts/backfill-member-filenames.ts            (doar afișează)
 *      APPLY=1 npx tsx scripts/backfill-member-filenames.ts    (scrie)
 */
import { PrismaClient } from "@prisma/client";
import { originalFileName } from "../src/lib/archive-names.js";

const prisma = new PrismaClient();
const GROUP_NAME = /^Dosar (Bransament|Conducta) /;

async function main() {
  const groups = await prisma.documentTemplate.findMany({ where: { tenantId: null, type: "group" }, select: { id: true, name: true } });
  let changed = 0;
  for (const g of groups.filter((g) => GROUP_NAME.test(g.name))) {
    const members = await prisma.documentTemplate.findMany({
      where: { parentGroupId: g.id },
      select: { id: true, name: true, description: true, fileName: true },
      orderBy: { memberOrder: "asc" },
    });
    for (const m of members) {
      if (m.fileName?.trim() || !m.description?.trim().toLowerCase().endsWith(".docx")) continue;
      const fileName = originalFileName(m.fileName, m.description.trim());
      console.log(`${g.name}: ${m.name} → ${fileName}`);
      if (process.env.APPLY === "1") await prisma.documentTemplate.update({ where: { id: m.id }, data: { fileName } });
      changed++;
    }
  }
  console.log(`\n${changed} ${process.env.APPLY === "1" ? "actualizate" : "de actualizat (APPLY=1 ca să scrie)"}`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
