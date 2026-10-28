/**
 * Workflow-urile generale (de sistem, tenantId null), disponibile tuturor firmelor:
 *
 *   - „Branșament gaze naturale” (tip `bransament`, orice distribuitor): certificat de urbanism →
 *     avize → autorizație de construire → schița → carte tehnică (setul distribuitorului
 *     proiectului) → cu participare ISC: date tehnice ISCIR → Dosar ISCIR.
 *   - „Conductă gaze naturale” (tip `conducta`): aceiași pași, apoi cartea tehnică de conductă.
 *
 * Se construiesc din vechiul `bransament_gaz_distrigaz` (pașii, formularele, termenele, acțiunile),
 * fără ramurile pe id-ul distribuitorului unei firme: generarea alege setul după distribuitorul
 * proiectului (`dossierCategory`). Vechiul workflow se arhivează (nu are instanțe).
 *
 * Run: npx tsx scripts/seed-general-workflows.ts   (DRY_RUN=1 = doar afișează, fără să scrie)
 */
import { PrismaClient, type Prisma } from "@prisma/client";

const prisma = new PrismaClient();
const SOURCE_CODE = "bransament_gaz_distrigaz";
const DRY_RUN = !!process.env.DRY_RUN;

/** Pașii comuni (până la schiță), în ordinea vechiului workflow. */
const COMMON = [
  "certificat_aviz_de_urbanism",
  "ridicare_certificat_aviz_urbanism",
  "depunere_avize",
  "ridicare_aviz",
  "depunere_autorizatie_constructie",
  "ridicare_autorizatie_constructie",
  "schita_proiect_tehnic",
];

type StepSpec = { code: string; from?: string; name?: string; stepType?: string; isTerminal?: boolean; configJson?: Record<string, unknown> };
type TransitionSpec = { from: string; to: string; type?: string; label?: string; condition?: Record<string, unknown>; copy?: boolean };

const iscFact = (value: boolean) => ({ all: [{ fact: "project.participareISC", value, operator: "equal" }] });

const PLANS: { code: string; name: string; description: string; projectTypeCode: string; steps: StepSpec[]; transitions: TransitionSpec[] }[] = [
  {
    code: "bransament_gaze_naturale",
    name: "Branșament gaze naturale",
    description: "Workflow general pentru branșamente: urbanism, avize, autorizație de construire, schiță, carte tehnică (setul distribuitorului proiectului), Dosar ISCIR la participare ISC.",
    projectTypeCode: "bransament",
    steps: [
      ...COMMON.map((code) => ({ code })),
      { code: "participare_isc", from: "generare_carte_tehnica", name: "Participare ISC?", isTerminal: false, configJson: { conditionField: "project.participareISC" } },
      { code: "carte_tehnica_isc", from: "step_mpl8jtky", name: "Generare Carte Tehnică Branșament", configJson: { dossierCategory: "CARTE_BRANSAMENT" } },
      { code: "date_tehnice_iscir" },
      { code: "generare_dosar_isc", name: "Generare Dosar ISCIR", configJson: { dossierCategory: "DOSAR_ISCIR" } },
      { code: "carte_tehnica", from: "step_mpl8lnp5", name: "Generare Carte Tehnică Branșament", configJson: { dossierCategory: "CARTE_BRANSAMENT" } },
    ],
    transitions: [
      ...chain(COMMON),
      { from: "schita_proiect_tehnic", to: "participare_isc" },
      { from: "participare_isc", to: "carte_tehnica_isc", type: "conditional", label: "Da", condition: iscFact(true) },
      { from: "participare_isc", to: "carte_tehnica", type: "conditional", label: "Nu", condition: iscFact(false) },
      { from: "carte_tehnica_isc", to: "date_tehnice_iscir" },
      { from: "date_tehnice_iscir", to: "generare_dosar_isc" },
    ],
  },
  {
    code: "conducta_gaze_naturale",
    name: "Conductă gaze naturale",
    description: "Workflow general pentru conducte de distribuție: urbanism, avize, autorizație de construire, schiță, carte tehnică de conductă (setul distribuitorului proiectului).",
    projectTypeCode: "conducta",
    steps: [
      ...COMMON.map((code) => ({ code })),
      { code: "carte_tehnica_conducta", from: "step_mpl8lnp5", name: "Generare Carte Tehnică Conductă", isTerminal: true, configJson: { dossierCategory: "CARTE_CONDUCTA" } },
    ],
    transitions: [...chain(COMMON), { from: "schita_proiect_tehnic", to: "carte_tehnica_conducta" }],
  },
];

/** Tranzițiile dintre pașii comuni se copiază din vechiul workflow (păstrează foreach-ul avizelor). */
function chain(codes: string[]): TransitionSpec[] {
  return codes.slice(0, -1).map((from, i) => ({ from, to: codes[i + 1], copy: true }));
}

async function main() {
  const source = await prisma.workflowDefinition.findFirst({
    where: { tenantId: null, code: SOURCE_CODE },
    orderBy: { version: "asc" },
    include: { steps: { include: { actions: true } }, transitions: true },
  });
  if (!source) throw new Error(`Lipsește workflow-ul sursă ${SOURCE_CODE}`);
  const byCode = new Map(source.steps.map((s) => [s.code, s]));
  const codeOf = new Map(source.steps.map((s) => [s.id, s.code]));

  await prisma.$transaction(async (tx) => {
    for (const plan of PLANS) {
      const exists = await tx.workflowDefinition.findFirst({ where: { tenantId: null, code: plan.code } });
      if (exists) {
        console.log(`= ${plan.code} există deja (${exists.id}), sărit`);
        continue;
      }
      const def = await tx.workflowDefinition.create({
        data: {
          tenantId: null,
          code: plan.code,
          name: plan.name,
          description: plan.description,
          projectTypeCode: plan.projectTypeCode,
          distributorCode: null,
          role: "primary",
          category: source.category,
          entityType: source.entityType,
          configJson: source.configJson ?? undefined,
          version: 1,
          status: "published",
          publishedAt: new Date(),
          baseDefinitionId: source.id,
        },
      });
      const ids = new Map<string, string>();
      for (const [i, spec] of plan.steps.entries()) {
        const src = byCode.get(spec.from ?? spec.code);
        if (!src) throw new Error(`Pasul ${spec.from ?? spec.code} lipsește din ${SOURCE_CODE}`);
        const step = await tx.workflowStep.create({
          data: {
            tenantId: null,
            workflowDefinitionId: def.id,
            code: spec.code,
            name: spec.name ?? src.name,
            stepType: spec.stepType ?? src.stepType,
            orderIndex: i,
            isStart: i === 0,
            isTerminal: spec.isTerminal ?? src.isTerminal,
            joinMode: src.joinMode,
            nameTemplate: src.nameTemplate,
            configJson: (spec.configJson ?? src.configJson ?? undefined) as Prisma.InputJsonValue | undefined,
            formSchemaJson: src.formSchemaJson ?? undefined,
            validationSchemaJson: src.validationSchemaJson ?? undefined,
            uiSchemaJson: src.uiSchemaJson ?? undefined,
          },
        });
        ids.set(spec.code, step.id);
        for (const a of src.actions) {
          await tx.workflowStepAction.create({
            data: {
              tenantId: null,
              stepId: step.id,
              triggerEvent: a.triggerEvent,
              actionType: a.actionType,
              targetFieldKey: a.targetFieldKey,
              actionConfigJson: a.actionConfigJson ?? undefined,
            },
          });
        }
      }
      for (const t of plan.transitions) {
        const old = t.copy
          ? source.transitions.find((x) => codeOf.get(x.fromStepId) === t.from && codeOf.get(x.toStepId) === t.to)
          : undefined;
        if (t.copy && !old) throw new Error(`Tranziția ${t.from} → ${t.to} lipsește din ${SOURCE_CODE}`);
        await tx.workflowTransition.create({
          data: {
            tenantId: null,
            workflowDefinitionId: def.id,
            fromStepId: ids.get(t.from)!,
            toStepId: ids.get(t.to)!,
            transitionType: old?.transitionType ?? t.type ?? "default",
            label: old?.label ?? t.label ?? null,
            priority: old?.priority ?? 0,
            conditionJson: (old?.conditionJson ?? t.condition ?? undefined) as Prisma.InputJsonValue | undefined,
            configJson: old?.configJson ?? undefined,
            spawnMode: old?.spawnMode ?? "single",
            foreachPath: old?.foreachPath ?? null,
            itemContextKey: old?.itemContextKey ?? null,
          },
        });
      }
      console.log(`+ ${plan.code}: ${plan.steps.length} pași, ${plan.transitions.length} tranziții (${def.id})`);
    }

    // Vechiul workflow compara id-ul distribuitorului unei singure firme — se arhivează, dacă nu rulează nicăieri.
    const running = await tx.workflowInstance.count({ where: { workflowDefinitionId: source.id } });
    if (running === 0 && source.status !== "archived") {
      await tx.workflowDefinition.updateMany({ where: { tenantId: null, code: SOURCE_CODE }, data: { status: "archived" } });
      console.log(`~ ${SOURCE_CODE} arhivat`);
    } else if (running) {
      console.log(`! ${SOURCE_CODE} are ${running} instanțe — rămâne publicat`);
    }
    if (DRY_RUN) throw new Error("DRY_RUN — nimic scris");
  });
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = DRY_RUN ? 0 : 1;
  })
  .finally(() => prisma.$disconnect());
