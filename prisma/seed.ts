import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
// Faithful ISCIR "Raport de verificări, încercări și probe" HTML (XLSX-shaped).
import { TEMPLATE_HTML as ISCIR_TEMPLATE_HTML } from "../scripts/update-iscir-template.js";

const prisma = new PrismaClient();

async function main() {
  // Create demo tenant
  const tenant = await prisma.tenant.upsert({
    where: { slug: "demo" },
    update: {},
    create: {
      name: "Demo Gas Company",
      slug: "demo",
      timezone: "Europe/Bucharest",
      locale: "ro",
    },
  });

  // Create master admin (no tenant — cross-tenant super admin)
  const passwordHash = await argon2.hash("password123");
  await prisma.user.upsert({
    where: { email: "master@operio.com" },
    update: {},
    create: {
      tenantId: null,
      email: "master@operio.com",
      passwordHash,
      firstName: "Master",
      lastName: "Admin",
      role: "MASTER_ADMIN",
    },
  });

  // Create admin user
  const admin = await prisma.user.upsert({
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

  // Create project types
  const projectTypes = await Promise.all([
    prisma.projectType.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: "bransament" } },
      update: {},
      create: {
        tenantId: tenant.id,
        code: "bransament",
        name: "Branșament Gaz",
        description: "Proiecte de branșament la rețeaua de gaze naturale",
      },
    }),
    prisma.projectType.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: "conducta" } },
      update: {},
      create: {
        tenantId: tenant.id,
        code: "conducta",
        name: "Extindere Conductă",
        description: "Proiecte de extindere a conductei de gaze",
      },
    }),
    prisma.projectType.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: "revizie_centrala" } },
      update: {},
      create: {
        tenantId: tenant.id,
        code: "revizie_centrala",
        name: "Revizie Centrală",
        description: "Revizii periodice ale centralelor termice",
      },
    }),
    prisma.projectType.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: "dosar_iscir" } },
      update: {},
      create: {
        tenantId: tenant.id,
        code: "dosar_iscir",
        name: "Dosar ISCIR",
        description: "Dosare pentru inspecții ISCIR",
      },
    }),
  ]);

  const [bransament, conducta, revizieCentrala, dosarIscir] = projectTypes;

  // Create distributors
  const distributors = await Promise.all([
    prisma.distributor.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: "DISTRIGAZ" } },
      update: {},
      create: {
        tenantId: tenant.id,
        code: "DISTRIGAZ",
        name: "Distrigaz",
      },
    }),
    prisma.distributor.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: "NEOGAS_GRID" } },
      update: {},
      create: {
        tenantId: tenant.id,
        code: "NEOGAS_GRID",
        name: "Neogas Grid",
      },
    }),
    prisma.distributor.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: "MEGACONSTRUCT" } },
      update: {},
      create: {
        tenantId: tenant.id,
        code: "MEGACONSTRUCT",
        name: "Megaconstruct",
      },
    }),
  ]);

  const [distrigaz, _neogas, _mega] = distributors;

  // Create sample clients
  const clientCompany = await prisma.client.create({
    data: {
      tenantId: tenant.id,
      type: "COMPANY",
      companyName: "SC Gaz Construct SRL",
      cui: "RO12345678",
      phone: "0264-123-456",
      email: "office@gazconstruct.ro",
      addresses: {
        create: [
          {
            address: "Str. Industriei nr. 15",
            isPrimary: true,
          },
        ],
      },
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

  const clientPerson = await prisma.client.create({
    data: {
      tenantId: tenant.id,
      type: "PERSON",
      firstName: "Vasile",
      lastName: "Georgescu",
      phone: "0740-555-666",
      email: "vasile.georgescu@email.ro",
      addresses: {
        create: [
          {
            address: "Str. Florilor nr. 7",
            isPrimary: true,
          },
        ],
      },
    },
  });

  // ── Seed Workflow Definitions ──────────────────────────────────────────

  // Helper to create a full workflow definition with steps and transitions
  async function createWorkflowDefinition(opts: {
    tenantId: string;
    projectTypeId: string;
    code: string;
    name: string;
    description: string;
    createdById: string;
    steps: Array<{
      code: string;
      name: string;
      stepType: string;
      orderIndex: number;
      isStart?: boolean;
      isTerminal?: boolean;
      configJson?: any;
    }>;
    transitions: Array<{
      fromStepCode: string;
      toStepCode: string;
      transitionType: string;
      label?: string;
      priority?: number;
      conditionJson?: any;
    }>;
  }) {
    // Check if already exists
    const existing = await prisma.workflowDefinition.findFirst({
      where: { tenantId: opts.tenantId, code: opts.code, version: 1 },
    });
    if (existing) return existing;

    const definition = await prisma.workflowDefinition.create({
      data: {
        tenantId: opts.tenantId,
        projectTypeId: opts.projectTypeId,
        code: opts.code,
        name: opts.name,
        description: opts.description,
        entityType: "project",
        version: 1,
        status: "published",
        isActive: true,
        publishedAt: new Date(),
        createdById: opts.createdById,
      },
    });

    // Create steps
    const stepMap = new Map<string, string>();
    for (const step of opts.steps) {
      const created = await prisma.workflowStep.create({
        data: {
          tenantId: opts.tenantId,
          workflowDefinitionId: definition.id,
          code: step.code,
          name: step.name,
          stepType: step.stepType,
          orderIndex: step.orderIndex,
          isStart: step.isStart ?? false,
          isTerminal: step.isTerminal ?? false,
          configJson: step.configJson ?? null,
        },
      });
      stepMap.set(step.code, created.id);
    }

    // Create transitions
    for (const t of opts.transitions) {
      const fromId = stepMap.get(t.fromStepCode);
      const toId = stepMap.get(t.toStepCode);
      if (!fromId || !toId) continue;

      await prisma.workflowTransition.create({
        data: {
          tenantId: opts.tenantId,
          workflowDefinitionId: definition.id,
          fromStepId: fromId,
          toStepId: toId,
          transitionType: t.transitionType,
          label: t.label ?? null,
          priority: t.priority ?? 0,
          conditionJson: t.conditionJson ?? null,
        },
      });
    }

    return definition;
  }

  // ── Branșament / Conductă Workflow ──────────────────────────────────────
  const bransamentSteps = [
    { code: "depunere_cerere_cu", name: "Depunere cerere Certificat Urbanism", stepType: "human_task", orderIndex: 0, isStart: true, configJson: { institution: "Primăria", estimatedDays: 30 } },
    { code: "obtinere_cu", name: "Obținere Certificat Urbanism", stepType: "human_task", orderIndex: 1, configJson: { institution: "Primăria", estimatedDays: 0 } },
    { code: "avize_necesare", name: "Avize necesare?", stepType: "decision", orderIndex: 2 },
    { code: "aviz_mediu", name: "Aviz Mediu", stepType: "human_task", orderIndex: 3, configJson: { institution: "Agenția de Mediu", estimatedDays: 30 } },
    { code: "aviz_canal", name: "Aviz Canal", stepType: "human_task", orderIndex: 4, configJson: { institution: "Compania de Apă", estimatedDays: 30 } },
    { code: "aviz_politie", name: "Aviz Poliție", stepType: "human_task", orderIndex: 5, configJson: { institution: "Poliția Rutieră", estimatedDays: 30 } },
    { code: "aviz_telecom", name: "Aviz Telecom", stepType: "human_task", orderIndex: 6, configJson: { institution: "Telekom/Digi", estimatedDays: 30 } },
    { code: "aviz_electrica", name: "Aviz Electrică", stepType: "human_task", orderIndex: 7, configJson: { institution: "Distribuție Energie", estimatedDays: 30 } },
    { code: "depunere_ac", name: "Depunere dosar Autorizație Construire", stepType: "human_task", orderIndex: 8, configJson: { institution: "Primăria", estimatedDays: 30 } },
    { code: "obtinere_ac", name: "Obținere Autorizație Construire", stepType: "human_task", orderIndex: 9, configJson: { institution: "Primăria", estimatedDays: 0 } },
    { code: "executie", name: "Execuție lucrări", stepType: "human_task", orderIndex: 10, configJson: { estimatedDays: 14 } },
    { code: "receptie", name: "Recepție finală", stepType: "human_task", orderIndex: 11, configJson: { estimatedDays: 7 } },
    { code: "finalizat", name: "Finalizat", stepType: "final", orderIndex: 12, isTerminal: true },
  ];

  const bransamentTransitions = [
    { fromStepCode: "depunere_cerere_cu", toStepCode: "obtinere_cu", transitionType: "default" },
    { fromStepCode: "obtinere_cu", toStepCode: "avize_necesare", transitionType: "default" },
    // Decision: if permits needed
    { fromStepCode: "avize_necesare", toStepCode: "aviz_mediu", transitionType: "conditional", label: "Da", priority: 1, conditionJson: { all: [{ fact: "step_output.needs_permits", operator: "equal", value: true }] } },
    { fromStepCode: "avize_necesare", toStepCode: "depunere_ac", transitionType: "conditional", label: "Nu", priority: 0, conditionJson: { all: [{ fact: "step_output.needs_permits", operator: "equal", value: false }] } },
    // Permit steps all lead to depunere AC
    { fromStepCode: "aviz_mediu", toStepCode: "depunere_ac", transitionType: "default" },
    { fromStepCode: "aviz_canal", toStepCode: "depunere_ac", transitionType: "default" },
    { fromStepCode: "aviz_politie", toStepCode: "depunere_ac", transitionType: "default" },
    { fromStepCode: "aviz_telecom", toStepCode: "depunere_ac", transitionType: "default" },
    { fromStepCode: "aviz_electrica", toStepCode: "depunere_ac", transitionType: "default" },
    // Continue flow
    { fromStepCode: "depunere_ac", toStepCode: "obtinere_ac", transitionType: "default" },
    { fromStepCode: "obtinere_ac", toStepCode: "executie", transitionType: "default" },
    { fromStepCode: "executie", toStepCode: "receptie", transitionType: "default" },
    { fromStepCode: "receptie", toStepCode: "finalizat", transitionType: "default" },
  ];

  await createWorkflowDefinition({
    tenantId: tenant.id,
    projectTypeId: bransament.id,
    code: "bransament_standard",
    name: "Branșament Standard",
    description: "Flux standard pentru proiecte de branșament gaz",
    createdById: admin.id,
    steps: bransamentSteps,
    transitions: bransamentTransitions,
  });

  await createWorkflowDefinition({
    tenantId: tenant.id,
    projectTypeId: conducta.id,
    code: "conducta_standard",
    name: "Extindere Conductă Standard",
    description: "Flux standard pentru proiecte de extindere conductă",
    createdById: admin.id,
    steps: bransamentSteps, // Same steps as bransament
    transitions: bransamentTransitions,
  });

  // ── Revizie Centrală Workflow ──────────────────────────────────────────
  await createWorkflowDefinition({
    tenantId: tenant.id,
    projectTypeId: revizieCentrala.id,
    code: "revizie_centrala_standard",
    name: "Revizie Centrală Standard",
    description: "Flux standard pentru revizii de centrală termică",
    createdById: admin.id,
    steps: [
      { code: "programare", name: "Programare revizie", stepType: "human_task", orderIndex: 0, isStart: true, configJson: { estimatedDays: 0 } },
      { code: "inspectie", name: "Deplasare și inspecție", stepType: "human_task", orderIndex: 1, configJson: { estimatedDays: 1 } },
      { code: "raport", name: "Completare raport revizie", stepType: "document_generation", orderIndex: 2, configJson: { estimatedDays: 3 } },
      { code: "predare", name: "Predare documente client", stepType: "human_task", orderIndex: 3, configJson: { estimatedDays: 2 } },
      { code: "finalizat", name: "Finalizat", stepType: "final", orderIndex: 4, isTerminal: true },
      { code: "followup", name: "Follow-up peste 2 ani", stepType: "timer_wait", orderIndex: 5, isTerminal: true, configJson: { duration: { years: 2 }, action: "create_followup" } },
    ],
    transitions: [
      { fromStepCode: "programare", toStepCode: "inspectie", transitionType: "default" },
      { fromStepCode: "inspectie", toStepCode: "raport", transitionType: "default" },
      { fromStepCode: "raport", toStepCode: "predare", transitionType: "default" },
      { fromStepCode: "predare", toStepCode: "finalizat", transitionType: "default" },
      { fromStepCode: "finalizat", toStepCode: "followup", transitionType: "default" },
    ],
  });

  // ── Dosar ISCIR Workflow ───────────────────────────────────────────────
  await createWorkflowDefinition({
    tenantId: tenant.id,
    projectTypeId: dosarIscir.id,
    code: "dosar_iscir_standard",
    name: "Dosar ISCIR Standard",
    description: "Flux standard pentru dosare ISCIR",
    createdById: admin.id,
    steps: [
      { code: "documentatie", name: "Pregătire documentație", stepType: "human_task", orderIndex: 0, isStart: true, configJson: { estimatedDays: 5 } },
      { code: "convocare", name: "Convocare ISCIR", stepType: "human_task", orderIndex: 1, configJson: { institution: "ISCIR", estimatedDays: 14 } },
      { code: "inspectie", name: "Inspecție ISCIR", stepType: "human_task", orderIndex: 2, configJson: { institution: "ISCIR", estimatedDays: 1 } },
      { code: "proces_verbal", name: "Completare proces verbal", stepType: "document_generation", orderIndex: 3, configJson: { estimatedDays: 3 } },
      { code: "predare", name: "Predare documente", stepType: "human_task", orderIndex: 4, configJson: { estimatedDays: 2 } },
      { code: "finalizat", name: "Finalizat", stepType: "final", orderIndex: 5, isTerminal: true },
    ],
    transitions: [
      { fromStepCode: "documentatie", toStepCode: "convocare", transitionType: "default" },
      { fromStepCode: "convocare", toStepCode: "inspectie", transitionType: "default" },
      { fromStepCode: "inspectie", toStepCode: "proces_verbal", transitionType: "default" },
      { fromStepCode: "proces_verbal", toStepCode: "predare", transitionType: "default" },
      { fromStepCode: "predare", toStepCode: "finalizat", transitionType: "default" },
    ],
  });

  // ── Seed Projects ──────────────────────────────────────────────────

  const project1 = await prisma.project.upsert({
    where: { id: "seed-project-1" },
    update: {},
    create: {
      id: "seed-project-1",
      tenantId: tenant.id,
      clientId: clientCompany.id,
      projectTypeId: bransament.id,
      distributorId: distrigaz.id,
      name: "Branșament Gaz - SC Gaz Construct SRL",
      address: "Str. Industriei nr. 15",
      city: "Cluj-Napoca",
      county: "Cluj",
      status: "in_progress",
      priority: "high",
    },
  });

  const project2 = await prisma.project.upsert({
    where: { id: "seed-project-2" },
    update: {},
    create: {
      id: "seed-project-2",
      tenantId: tenant.id,
      clientId: clientPerson.id,
      projectTypeId: conducta.id,
      distributorId: distrigaz.id,
      name: "Extindere Conductă - Georgescu Vasile",
      address: "Str. Florilor nr. 7",
      city: "Cluj-Napoca",
      county: "Cluj",
      status: "in_progress",
      priority: "normal",
    },
  });

  // ── Seed Vehicles ────────────────────────────────────────────────────

  const vehicle1 = await prisma.vehicle.upsert({
    where: { id: "seed-vehicle-1" },
    update: {},
    create: {
      id: "seed-vehicle-1",
      tenantId: tenant.id,
      licensePlate: "CJ-01-GAZ",
      make: "Dacia",
      model: "Duster",
      year: 2022,
      fuelType: "diesel",
      insuranceExpiry: new Date(Date.now() + 5 * 24 * 60 * 60_000), // expires in 5 days
      itpExpiry: new Date(Date.now() - 2 * 24 * 60 * 60_000), // expired 2 days ago
    },
  });

  const vehicle2 = await prisma.vehicle.upsert({
    where: { id: "seed-vehicle-2" },
    update: {},
    create: {
      id: "seed-vehicle-2",
      tenantId: tenant.id,
      licensePlate: "CJ-02-GAZ",
      make: "Ford",
      model: "Transit",
      year: 2021,
      fuelType: "diesel",
      insuranceExpiry: new Date(Date.now() + 90 * 24 * 60 * 60_000),
      itpExpiry: new Date(Date.now() + 3 * 24 * 60 * 60_000), // expires in 3 days
    },
  });

  // ── Seed Notifications ───────────────────────────────────────────────

  const existingNotifications = await prisma.notification.count({
    where: { tenantId: tenant.id },
  });

  if (existingNotifications === 0) {
    const now = new Date();
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

    await prisma.notification.createMany({
      data: [
        // ── System ──
        {
          tenantId: tenant.id,
          userId: admin.id,
          channel: "in_app",
          category: "system",
          subject: "Bine ai venit în Operio!",
          body: "Contul tău de administrator a fost creat cu succes. Explorează aplicația pentru a configura proiecte și workflow-uri.",
          status: "sent",
          sentAt: minutesAgo(120),
        },
        // ── Projects (read) ──
        {
          tenantId: tenant.id,
          userId: admin.id,
          channel: "in_app",
          category: "projects",
          projectId: project1.id,
          clientId: clientCompany.id,
          subject: "Proiect nou asignat",
          body: "Proiectul 'Branșament Gaz - SC Gaz Construct SRL' a fost creat și ți-a fost asignat.",
          status: "sent",
          sentAt: minutesAgo(90),
        },
        {
          tenantId: tenant.id,
          userId: admin.id,
          channel: "in_app",
          category: "projects",
          projectId: project1.id,
          subject: "Pas workflow finalizat",
          body: "Pasul 'Depunere cerere Certificat Urbanism' a fost completat pentru proiectul Branșament Standard.",
          status: "sent",
          sentAt: minutesAgo(45),
        },
        {
          tenantId: tenant.id,
          userId: admin.id,
          channel: "in_app",
          category: "projects",
          projectId: project1.id,
          subject: "Document generat",
          body: "Cartea de branșament a fost generată cu succes și este disponibilă pentru descărcare.",
          status: "sent",
          sentAt: minutesAgo(30),
        },
        // ── Tasks (read) ──
        {
          tenantId: tenant.id,
          userId: admin.id,
          channel: "in_app",
          category: "tasks",
          subject: "Task finalizat",
          body: "Task-ul 'Verificare documentație ISCIR' pentru dosarul #127 a fost finalizat.",
          status: "sent",
          sentAt: minutesAgo(10),
        },
        // ── Fleet (read) ──
        {
          tenantId: tenant.id,
          userId: admin.id,
          channel: "in_app",
          category: "fleet",
          subject: "Revizie efectuată",
          body: "Revizia vehiculului CJ-01-GAZ (Dacia Duster) a fost efectuată cu succes.",
          status: "sent",
          sentAt: minutesAgo(60),
          vehicleId: vehicle1.id,
        },
        // ── Unread: Projects ──
        {
          tenantId: tenant.id,
          userId: admin.id,
          channel: "in_app",
          category: "projects",
          projectId: project2.id,
          clientId: clientPerson.id,
          subject: "Termen aproape depășit",
          body: "Proiectul 'Extindere Conductă - Georgescu Vasile' are termenul de obținere aviz mediu în 2 zile.",
          status: "sent",
          metadataJson: { priority: "warning" },
        },
        {
          tenantId: tenant.id,
          userId: admin.id,
          channel: "in_app",
          category: "projects",
          projectId: project1.id,
          clientId: clientCompany.id,
          subject: "Aviz expirat",
          body: "Avizul de mediu pentru proiectul 'Branșament - SC Gaz Construct SRL' a expirat. Trebuie reînnoit.",
          status: "sent",
          metadataJson: { priority: "urgent" },
        },
        // ── Unread: Fleet ──
        {
          tenantId: tenant.id,
          userId: admin.id,
          channel: "in_app",
          category: "fleet",
          subject: "ITP expirat",
          body: "ITP-ul vehiculului CJ-01-GAZ (Dacia Duster) a expirat acum 2 zile. Programează inspecția tehnica cât mai curând.",
          status: "sent",
          vehicleId: vehicle1.id,
          metadataJson: { priority: "urgent" },
        },
        {
          tenantId: tenant.id,
          userId: admin.id,
          channel: "in_app",
          category: "fleet",
          subject: "Asigurare expiră în curând",
          body: "Asigurarea vehiculului CJ-02-GAZ (Ford Transit) expiră în 3 zile. Reînnoiește polița RCA.",
          status: "sent",
          vehicleId: vehicle2.id,
          metadataJson: { priority: "warning" },
        },
        // ── Unread: Tasks ──
        {
          tenantId: tenant.id,
          userId: admin.id,
          channel: "in_app",
          category: "tasks",
          subject: "Task nou",
          body: "Ai un task nou: 'Pregătire documentație' pentru proiectul Extindere Conductă #89.",
          status: "sent",
        },
        // ── Email (sent) ──
        {
          tenantId: tenant.id,
          userId: admin.id,
          channel: "email",
          category: "system",
          subject: "Raport săptămânal proiecte",
          body: "Raportul săptămânal cu statusul proiectelor active a fost trimis la admin@demo.com.",
          status: "sent",
          sentAt: minutesAgo(60),
        },
        // ── Email (scheduled) ──
        {
          tenantId: tenant.id,
          userId: admin.id,
          channel: "email",
          category: "projects",
          subject: "Reminder: Inspecție ISCIR programată",
          body: "Mâine este programată inspecția ISCIR pentru dosarul #142. Asigură-te că documentația este completă.",
          status: "scheduled",
          scheduledAt: new Date(now.getTime() + 24 * 60 * 60_000),
        },
      ],
    });
  }

  // Create template categories + ISCIR revision template
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

  // Upsert ISCIR template (global, no tenantId) — faithful XLSX-shaped HTML
  const existingIscir = await prisma.documentTemplate.findFirst({
    where: { tenantId: null, categoryCode: "REVIZIE_CENTRALA", name: "Raport Revizie Centrală (ISCIR)" },
  });
  if (!existingIscir) {
    await prisma.documentTemplate.create({
      data: {
        tenantId: null,
        categoryCode: "REVIZIE_CENTRALA",
        name: "Raport Revizie Centrală (ISCIR)",
        description: "Raport oficial de verificări, încercări și probe conform prescripției tehnice A1/2010",
        content: ISCIR_TEMPLATE_HTML,
        sortOrder: 1,
        isActive: true,
      },
    });
    console.log("Seed completed: ISCIR revision template created");
  }

  console.log("Seed completed: tenant 'demo' with admin@demo.com / password123");
  console.log("Seed completed: project types created");
  console.log("Seed completed: workflow definitions created");
  console.log("Seed completed: notifications created");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
