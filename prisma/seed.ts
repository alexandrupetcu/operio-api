import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";

const prisma = new PrismaClient();

async function main() {
  // Create demo tenant
  const tenant = await prisma.tenant.upsert({
    where: { slug: "demo" },
    update: {},
    create: {
      name: "Demo Gas Company",
      slug: "demo",
    },
  });

  // Create admin user
  const passwordHash = await argon2.hash("password123");
  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: "admin@demo.com" } },
    update: {},
    create: {
      tenantId: tenant.id,
      email: "admin@demo.com",
      passwordHash,
      firstName: "Admin",
      lastName: "User",
      role: "ADMIN",
    },
  });

  // Create operator user
  await prisma.user.upsert({
    where: {
      tenantId_email: { tenantId: tenant.id, email: "operator@demo.com" },
    },
    update: {},
    create: {
      tenantId: tenant.id,
      email: "operator@demo.com",
      passwordHash,
      firstName: "Operator",
      lastName: "User",
      role: "OPERATOR",
    },
  });

  // Create sample company client
  await prisma.client.create({
    data: {
      tenantId: tenant.id,
      type: "COMPANY",
      companyName: "SC Gaz Construct SRL",
      cui: "RO12345678",
      address: "Str. Industriei nr. 15",
      city: "Cluj-Napoca",
      county: "Cluj",
      phone: "0264-123-456",
      email: "office@gazconstruct.ro",
      contactPersons: {
        create: [
          {
            firstName: "Ion",
            lastName: "Popescu",
            phone: "0740-111-222",
            email: "ion.popescu@gazconstruct.ro",
          },
          {
            firstName: "Maria",
            lastName: "Ionescu",
            phone: "0740-333-444",
            email: "maria.ionescu@gazconstruct.ro",
          },
        ],
      },
    },
  });

  // Create sample person client
  await prisma.client.create({
    data: {
      tenantId: tenant.id,
      type: "PERSON",
      firstName: "Vasile",
      lastName: "Georgescu",
      address: "Str. Florilor nr. 7",
      city: "Oradea",
      county: "Bihor",
      phone: "0740-555-666",
      email: "vasile.georgescu@email.ro",
    },
  });

  // Seed default workflow templates (system-wide, tenantId = null)

  // BRANSAMENT / CONDUCTA template
  const bransamentSteps = [
    { sortOrder: 0, name: "Depunere cerere Certificat Urbanism", institution: "Primăria", estimatedDays: 30, isSelectable: false },
    { sortOrder: 1, name: "Obținere Certificat Urbanism", institution: "Primăria", estimatedDays: 0, isSelectable: false },
    { sortOrder: 2, name: "Aviz Mediu", institution: "Agenția de Mediu", estimatedDays: 30, dependsOnStepOrder: 1, isSelectable: true, isSelectedByDefault: true },
    { sortOrder: 3, name: "Aviz Canal", institution: "Compania de Apă", estimatedDays: 30, dependsOnStepOrder: 1, isSelectable: true, isSelectedByDefault: true },
    { sortOrder: 4, name: "Aviz Poliție", institution: "Poliția Rutieră", estimatedDays: 30, dependsOnStepOrder: 1, isSelectable: true, isSelectedByDefault: false },
    { sortOrder: 5, name: "Aviz Telecom", institution: "Telekom/Digi", estimatedDays: 30, dependsOnStepOrder: 1, isSelectable: true, isSelectedByDefault: false },
    { sortOrder: 6, name: "Aviz Electrică", institution: "Distribuție Energie", estimatedDays: 30, dependsOnStepOrder: 1, isSelectable: true, isSelectedByDefault: false },
    { sortOrder: 7, name: "Depunere dosar Autorizație Construire", institution: "Primăria", estimatedDays: 30, isSelectable: false },
    { sortOrder: 8, name: "Obținere Autorizație Construire", institution: "Primăria", estimatedDays: 0, isSelectable: false },
    { sortOrder: 9, name: "Execuție lucrări", estimatedDays: 14, isSelectable: false },
    { sortOrder: 10, name: "Recepție finală", estimatedDays: 7, isSelectable: false },
  ];

  // Create for BRANSAMENT
  await prisma.workflowTemplate.upsert({
    where: { id: "system-bransament-default" },
    update: {},
    create: {
      id: "system-bransament-default",
      tenantId: null,
      projectType: "BRANSAMENT",
      name: "Branșament Standard",
      description: "Flux standard pentru proiecte de branșament gaz",
      isDefault: true,
      steps: { create: bransamentSteps },
    },
  });

  // Create for CONDUCTA (same steps)
  await prisma.workflowTemplate.upsert({
    where: { id: "system-conducta-default" },
    update: {},
    create: {
      id: "system-conducta-default",
      tenantId: null,
      projectType: "CONDUCTA",
      name: "Extindere Conductă Standard",
      description: "Flux standard pentru proiecte de extindere conductă",
      isDefault: true,
      steps: { create: bransamentSteps },
    },
  });

  // REVIZIE_CENTRALA template
  await prisma.workflowTemplate.upsert({
    where: { id: "system-revizie-default" },
    update: {},
    create: {
      id: "system-revizie-default",
      tenantId: null,
      projectType: "REVIZIE_CENTRALA",
      name: "Revizie Centrală Standard",
      description: "Flux standard pentru revizii de centrală termică",
      isDefault: true,
      steps: {
        create: [
          { sortOrder: 0, name: "Programare revizie", estimatedDays: 0 },
          { sortOrder: 1, name: "Deplasare și inspecție", estimatedDays: 1 },
          { sortOrder: 2, name: "Completare raport revizie", estimatedDays: 3 },
          { sortOrder: 3, name: "Predare documente client", estimatedDays: 2 },
        ],
      },
    },
  });

  // DOSAR_ISCIR template
  await prisma.workflowTemplate.upsert({
    where: { id: "system-iscir-default" },
    update: {},
    create: {
      id: "system-iscir-default",
      tenantId: null,
      projectType: "DOSAR_ISCIR",
      name: "Dosar ISCIR Standard",
      description: "Flux standard pentru dosare ISCIR",
      isDefault: true,
      steps: {
        create: [
          { sortOrder: 0, name: "Pregătire documentație", estimatedDays: 5 },
          { sortOrder: 1, name: "Convocare ISCIR", institution: "ISCIR", estimatedDays: 14 },
          { sortOrder: 2, name: "Inspecție ISCIR", institution: "ISCIR", estimatedDays: 1 },
          { sortOrder: 3, name: "Completare proces verbal", estimatedDays: 3 },
          { sortOrder: 4, name: "Predare documente", estimatedDays: 2 },
        ],
      },
    },
  });

  console.log("Seed completed: tenant 'demo' with admin@demo.com / password123");
  console.log("Seed completed: default workflow templates created");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
