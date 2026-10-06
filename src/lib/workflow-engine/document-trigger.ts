import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { Queue } from "bullmq";
import { redisConnection } from "../../config/redis.js";

const documentQueue = new Queue("document-generation", {
  connection: redisConnection,
});

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
