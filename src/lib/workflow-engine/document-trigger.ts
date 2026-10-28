import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { Queue } from "bullmq";
import { redisConnection } from "../../config/redis.js";
import { defaultJobOptions } from "../../config/queue.js";

const documentQueue = new Queue("document-generation", { connection: redisConnection, defaultJobOptions });

/**
 * Trigger document generation when a document_generation step is activated.
 *
 * Reads templateIds or category from step configJson, creates Document records,
 * and queues BullMQ jobs for the existing document-generation worker.
 */
export async function triggerDocumentGeneration(
  fastify: FastifyInstance,
  tenantId: string,
  stepInstanceId: string,
  workflowInstance: {
    id: string;
    entityId?: string | null;
    entityType?: string | null;
  },
  stepConfig: Record<string, unknown>
): Promise<boolean> {
  const projectId = workflowInstance.entityId;
  if (!projectId) {
    fastify.log.warn(
      { stepInstanceId },
      "document_generation step: no entityId (projectId) on workflow instance"
    );
    await markStepFailed(fastify, tenantId, stepInstanceId, {
      message: "Nu există un proiect asociat acestui workflow. Generarea documentelor necesită un proiect.",
      code: "NO_PROJECT_LINKED",
    });
    return false;
  }

  // Determine which templates to use
  let templateIds: string[] = [];

  if (Array.isArray(stepConfig.templateIds) && stepConfig.templateIds.length > 0) {
    templateIds = stepConfig.templateIds as string[];
  } else if (stepConfig.category) {
    const templates = await fastify.prisma.documentTemplate.findMany({
      where: {
        category: stepConfig.category as any,
        OR: [{ tenantId }, { tenantId: null }],
        isActive: true,
      },
      select: { id: true },
      orderBy: { sortOrder: "asc" },
    });
    templateIds = templates.map((t) => t.id);
  } else if (typeof stepConfig.dossierCategory === "string") {
    // Workflow general: setul dosarului (CARTE_BRANSAMENT, CARTE_CONDUCTA, DOSAR_ISCIR) după proiect —
    // cel ales în „Completează dosarul”, altfel grupul categoriei pentru distribuitorul proiectului
    // (al firmei înaintea celui de sistem; un grup fără distribuitor e bun pentru oricare).
    const groupId = await dossierGroupFor(fastify, tenantId, projectId, stepConfig.dossierCategory);
    if (!groupId) {
      await markStepFailed(fastify, tenantId, stepInstanceId, {
        message:
          "Nu s-a găsit setul de documente pentru acest proiect. Alegeți distribuitorul proiectului sau deschideți „Completează dosarul” și alegeți setul.",
        code: "DOSSIER_GROUP_NOT_FOUND",
        dossierCategory: stepConfig.dossierCategory,
      });
      return false;
    }
    templateIds = [groupId];
  } else if (stepConfig.templateRef) {
    // Single template reference by ID. A DOCX group is NOT flattened here — it
    // becomes one Document whose file is a ZIP of all rendered members (the
    // doc-generation worker bundles them), so keep the group id as-is.
    templateIds = [stepConfig.templateRef as string];
  }

  if (templateIds.length === 0) {
    fastify.log.warn(
      { stepInstanceId, stepConfig },
      "document_generation step: no templates found"
    );
    await markStepFailed(fastify, tenantId, stepInstanceId, {
      message: "Nu s-au găsit șabloane de documente pentru acest pas. Verificați configurarea (templateIds, category sau templateRef).",
      code: "NO_TEMPLATES_FOUND",
      stepConfig,
    });
    return false;
  }

  // Look up a userId from the workflow instance (use the step's assignedUser or fallback)
  const stepInstance = await fastify.prisma.workflowStepInstance.findFirst({
    where: { id: stepInstanceId },
    select: { assignedUserId: true },
  });

  // Create Document records and queue jobs
  const templates = await fastify.prisma.documentTemplate.findMany({
    where: {
      id: { in: templateIds },
      OR: [{ tenantId }, { tenantId: null }],
      isActive: true,
    },
  });

  // Un șablon șters / dezactivat: pasul ar aștepta la nesfârșit documente care nu se mai fac.
  const missing = templateIds.filter((id) => !templates.some((t) => t.id === id));
  if (missing.length > 0) {
    fastify.log.warn({ stepInstanceId, missing }, "document_generation step: templates not found or inactive");
    await markStepFailed(fastify, tenantId, stepInstanceId, {
      message: "Șablonul de documente al acestui pas nu mai există sau a fost dezactivat. Alegeți alt șablon în configurarea workflow-ului.",
      code: "TEMPLATE_NOT_FOUND",
      missing,
    });
    return false;
  }

  const documents = await Promise.all(
    templates.map((template) =>
      fastify.prisma.document.create({
        data: {
          tenantId,
          templateId: template.id,
          generatedById: stepInstance?.assignedUserId ?? null,
          workflowStepInstanceId: stepInstanceId,
          name: template.name,
          status: "PENDING",
          projects: {
            create: { projectId },
          },
        },
      })
    )
  );

  // Queue BullMQ jobs
  await Promise.all(
    documents.map((doc) =>
      documentQueue.add("generate", {
        documentId: doc.id,
        tenantId,
        projectId,
        templateId: doc.templateId,
      })
    )
  );

  fastify.log.info(
    {
      stepInstanceId,
      documentCount: documents.length,
      documentIds: documents.map((d) => d.id),
    },
    "document_generation step: queued document generation jobs"
  );

  return true;
}

/**
 * Mark a step as failed directly using the prisma client (works inside a transaction).
 * Unlike failStep() from step-completion which wraps in $transaction,
 * this uses fastify.prisma directly since we may already be inside a transaction.
 */
async function markStepFailed(
  fastify: FastifyInstance,
  tenantId: string,
  stepInstanceId: string,
  error: Record<string, unknown>
): Promise<void> {
  const stepInstance = await fastify.prisma.workflowStepInstance.findFirst({
    where: { id: stepInstanceId, tenantId },
    include: { stepDefinition: true },
  });

  if (!stepInstance) return;

  await fastify.prisma.workflowStepInstance.update({
    where: { id: stepInstanceId },
    data: {
      status: "failed",
      completedAt: new Date(),
      errorJson: error as Prisma.InputJsonValue,
    },
  });

  await fastify.prisma.workflowExecutionLog.create({
    data: {
      tenantId,
      workflowInstanceId: stepInstance.workflowInstanceId,
      stepInstanceId,
      eventType: "step_failed",
      payloadJson: {
        stepCode: stepInstance.stepDefinition?.code ?? null,
        stepName: stepInstance.displayName ?? stepInstance.stepDefinition?.name ?? null,
        userId: "system",
        error,
      } as Prisma.InputJsonValue,
    },
  });
}

/** Grupul DOCX al dosarului de categoria dată pentru proiect (vezi `dossierCategory`). */
async function dossierGroupFor(
  fastify: FastifyInstance,
  tenantId: string,
  projectId: string,
  categoryCode: string
): Promise<string | null> {
  const project = await fastify.prisma.project.findFirst({
    where: { id: projectId, tenantId },
    select: {
      distributor: { select: { code: true } },
      templateGroup: { select: { id: true, categoryCode: true, isActive: true } },
    },
  });
  if (!project) return null;
  const chosen = project.templateGroup;
  if (chosen?.isActive && chosen.categoryCode === categoryCode) return chosen.id;

  const groups = await fastify.prisma.documentTemplate.findMany({
    where: { type: "group", isActive: true, categoryCode, OR: [{ tenantId }, { tenantId: null }] },
    select: { id: true, tenantId: true, distributorCode: true },
    orderBy: { createdAt: "asc" },
  });
  const code = project.distributor?.code ?? null;
  const rank = (g: (typeof groups)[number]) =>
    (g.distributorCode === code && code ? 0 : g.distributorCode === null ? 2 : 9) + (g.tenantId ? 0 : 1);
  const best = groups.filter((g) => rank(g) < 9).sort((a, b) => rank(a) - rank(b))[0];
  return best?.id ?? null;
}
