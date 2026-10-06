/**
 * Production bootstrap: global (tenantId: null) data only — no demo tenant,
 * no demo users (firms register through POST /api/auth/register).
 *   - REVIZIE_CENTRALA category + ISCIR "Raport de verificări" template
 *   - the 6 instalație templates (delegated to seed-instalatie-templates.ts)
 * Idempotent. In the container: docker compose exec api npx tsx scripts/seed-production.ts
 */
import { PrismaClient } from "@prisma/client";
import { TEMPLATE_HTML as ISCIR_TEMPLATE_HTML } from "./update-iscir-template.js";
import { seedInstalatieTemplates } from "./seed-instalatie-templates.js";

const prisma = new PrismaClient();

async function main() {
  await prisma.templateCategory.upsert({
    where: { code: "REVIZIE_CENTRALA" },
    update: {},
    create: {
      code: "REVIZIE_CENTRALA",
      name: "Revizie Centrală",
      description: "Documente pentru revizii periodice ale centralelor termice",
      icon: "Flame",
      color: "emerald",
      isActive: true,
      sortOrder: 3,
    },
  });

  const name = "Raport Revizie Centrală (ISCIR)";
  const existing = await prisma.documentTemplate.findFirst({
    where: { tenantId: null, categoryCode: "REVIZIE_CENTRALA", name },
  });
  if (existing) {
    await prisma.documentTemplate.update({ where: { id: existing.id }, data: { content: ISCIR_TEMPLATE_HTML, isActive: true } });
    console.log("  ~ refreshed: REVIZIE_CENTRALA");
  } else {
    await prisma.documentTemplate.create({
      data: {
        tenantId: null,
        categoryCode: "REVIZIE_CENTRALA",
        name,
        description: "Raport oficial de verificări, încercări și probe conform prescripției tehnice A1/2010",
        content: ISCIR_TEMPLATE_HTML,
        sortOrder: 1,
        isActive: true,
      },
    });
    console.log("  + created: REVIZIE_CENTRALA");
  }

  await seedInstalatieTemplates(prisma);
  console.log("\nProduction seed done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
