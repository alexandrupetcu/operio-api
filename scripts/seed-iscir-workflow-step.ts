/**
 * Insert a "Date tehnice ISCIR" human_task (with a form schema for the measured
 * field values) immediately BEFORE the "Generare Dosar ISC" document_generation
 * step, and point that step at the "Dosar ISCIR Template" DOCX group.
 *
 * The form field keys equal the template placeholders, so completing the step
 * fills them in the generated documents (via step-output → template context).
 *
 * Idempotent. Run: npx tsx --env-file=.env scripts/seed-iscir-workflow-step.ts
 */
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

const GEN_STEP_CODE = "generare_dosar_isc";
const NEW_STEP_CODE = "date_tehnice_iscir";

type F = { key: string; label: string; type: "text" | "number" | "date" };
const FIELDS: F[] = [
  { key: "pv_data", label: "Data execuție (PV-uri)", type: "date" },
  { key: "pv_trasare_nr", label: "Nr. PV trasare", type: "text" },
  { key: "pv_sapatura_nr", label: "Nr. PV săpătură", type: "text" },
  { key: "pv_asternere_nr", label: "Nr. PV așternere nisip", type: "text" },
  { key: "pv_montare_nr", label: "Nr. PV montare", type: "text" },
  { key: "pv_lansare_nr", label: "Nr. PV lansare", type: "text" },
  { key: "pv_rezistenta_nr", label: "Nr. PV probă rezistență", type: "text" },
  { key: "pv_etanseitate_nr", label: "Nr. PV probă etanșeitate", type: "text" },
  { key: "proba_rezistenta_presiune", label: "Presiune probă rezistență (bari)", type: "number" },
  { key: "proba_rezistenta_timp", label: "Timp probă rezistență (min)", type: "number" },
  { key: "timp_proba_rezistenta", label: "Durată probă rezistență (text, ex. „2 ore și 50 min”)", type: "text" },
  { key: "proba_rezistenta_temperatura", label: "Temperatură probă rezistență (°C)", type: "number" },
  { key: "proba_etanseitate_presiune", label: "Presiune probă etanșeitate (bari)", type: "number" },
  { key: "proba_etanseitate_timp", label: "Timp probă etanșeitate (min)", type: "number" },
  { key: "timp_proba_etanseitate", label: "Durată probă etanșeitate (text, ex. „24 ore și 30 min”)", type: "text" },
  { key: "proba_etanseitate_temperatura", label: "Temperatură probă etanșeitate (°C)", type: "number" },
  { key: "manometru_serie", label: "Manometru - serie", type: "text" },
  { key: "manometru_scala", label: "Manometru - scală", type: "text" },
  { key: "manometru_clasa", label: "Manometru - clasă precizie", type: "text" },
  { key: "manometru_verif_metrologica", label: "Manometru - ultima verif. metrologică", type: "date" },
];

const formSchema = {
  version: 1 as const,
  fields: FIELDS.map((f, i) => ({
    id: `f_${f.key}`,
    key: f.key,
    label: f.label,
    type: f.type,
    required: false,
    order: i,
  })),
};

async function main() {
  // 1. Locate the generation step (+ its definition).
  const genStep = await prisma.workflowStep.findFirst({ where: { code: GEN_STEP_CODE } });
  if (!genStep) {
    console.error(`No "${GEN_STEP_CODE}" step found — nothing to wire.`);
    process.exit(1);
  }
  const defId = genStep.workflowDefinitionId;

  // 2. Point the generation step at the populated group.
  const group = await prisma.documentTemplate.findFirst({
    where: { tenantId: null, type: "group", name: "Dosar ISCIR Template" },
  });
  if (group) {
    await prisma.workflowStep.update({
      where: { id: genStep.id },
      data: { configJson: { templateRef: group.id } as Prisma.InputJsonValue },
    });
    console.log(`Generare Dosar ISC → templateRef = ${group.id}`);
  } else {
    console.warn('Group "Dosar ISCIR Template" not found — run seed-iscir-template-group.ts first.');
  }

  // 3. Create the "Date tehnice ISCIR" step (idempotent).
  let newStep = await prisma.workflowStep.findFirst({
    where: { workflowDefinitionId: defId, code: NEW_STEP_CODE },
  });
  if (!newStep) {
    newStep = await prisma.workflowStep.create({
      data: {
        tenantId: genStep.tenantId,
        workflowDefinitionId: defId,
        code: NEW_STEP_CODE,
        name: "Date tehnice ISCIR",
        stepType: "human_task",
        orderIndex: genStep.orderIndex,
        isStart: false,
        isTerminal: false,
        configJson: { phase: "Dosar ISCIR" } as Prisma.InputJsonValue,
        formSchemaJson: formSchema as unknown as Prisma.InputJsonValue,
      },
    });
    console.log(`Created step "Date tehnice ISCIR" (${newStep.id})`);
  } else {
    await prisma.workflowStep.update({
      where: { id: newStep.id },
      data: { formSchemaJson: formSchema as unknown as Prisma.InputJsonValue },
    });
    console.log(`Step "Date tehnice ISCIR" exists (${newStep.id}) — form schema refreshed`);
  }

  // 4. Rewire transitions: <pred> → genStep  becomes  <pred> → newStep → genStep.
  const incoming = await prisma.workflowTransition.findMany({
    where: { workflowDefinitionId: defId, toStepId: genStep.id, fromStepId: { not: newStep.id } },
  });
  for (const t of incoming) {
    await prisma.workflowTransition.update({ where: { id: t.id }, data: { toStepId: newStep.id } });
    console.log(`  rerouted transition ${t.fromStepId} → (was genStep) → newStep`);
  }
  const link = await prisma.workflowTransition.findFirst({
    where: { workflowDefinitionId: defId, fromStepId: newStep.id, toStepId: genStep.id },
  });
  if (!link) {
    await prisma.workflowTransition.create({
      data: {
        tenantId: genStep.tenantId,
        workflowDefinitionId: defId,
        fromStepId: newStep.id,
        toStepId: genStep.id,
        transitionType: "default",
      },
    });
    console.log("  added transition: Date tehnice ISCIR → Generare Dosar ISC");
  }

  console.log("\nDone.");
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
