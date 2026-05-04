import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { calculateDeadlines } from "./deadline-calculator.js";
import { logEvent } from "./execution-logger.js";
import { executeActions } from "./action-executor.js";
import { resolveTransitions } from "./transition-resolver.js";

/**
 * Spawn a child workflow instance from a sub_workflow step.
 *
 * 1. Load the target WorkflowDefinition (must be published)
 * 2. Find the start step
 * 3. Create a child WorkflowInstance linked to the parent step instance
 * 4. Create the first child step instance (active)
 * 5. Pass parent context to child
 */
export async function spawnSubWorkflow(
  fastify: FastifyInstance,
  tenantId: string,
  parentStepInstanceId: string,
  parentWorkflowInstance: {
    id: string;
    workflowDefinitionId: string;
    contextJson: unknown;
    startedAt: Date;
    entityId?: string | null;
    entityType?: string | null;
  },
  subDefinitionId: string,
  itemContext: Record<string, unknown> | null
): Promise<string> {
  // 1. Load child definition
  const childDef = await fastify.prisma.workflowDefinition.findFirst({
    where: { id: subDefinitionId, status: "published" },
    include: {
      steps: { where: { isStart: true }, take: 1 },
    },
  });

  if (!childDef) {
    throw fastify.httpErrors.badRequest(
      `Sub-workflow definition "${subDefinitionId}" not found or not published.`
    );
  }

  const startStep = childDef.steps[0];
  if (!startStep) {
    throw fastify.httpErrors.badRequest(
      `Sub-workflow definition "${childDef.name}" has no start step.`
    );
  }

  // 2. Build child context from parent context + item context
  const parentContext =
    typeof parentWorkflowInstance.contextJson === "object" &&
    parentWorkflowInstance.contextJson !== null
      ? (parentWorkflowInstance.contextJson as Record<string, unknown>)
      : {};

  const childContext: Record<string, unknown> = {
    ...parentContext,
    ...(itemContext ?? {}),
    _parentWorkflowInstanceId: parentWorkflowInstance.id,
  };

  const now = new Date();

  // 3. Create child WorkflowInstance
  const childInstance = await fastify.prisma.workflowInstance.create({
    data: {
      tenantId,
      workflowDefinitionId: subDefinitionId,
      entityType: parentWorkflowInstance.entityType ?? "project",
      entityId: parentWorkflowInstance.entityId ?? "",
      status: "running",
      currentStepCode: startStep.code,
      contextJson: childContext as Prisma.InputJsonValue,
      startedAt: now,
      parentStepInstanceId,
      parentWorkflowInstanceId: parentWorkflowInstance.id,
    },
  });

  // 4. Create initial step instance
  const stepConfig = (startStep.configJson ?? {}) as Record<string, unknown>;
  const { availableAt, dueAt } = calculateDeadlines(
    {
      duePolicy: stepConfig.duePolicy as string | undefined,
      estimatedDays: stepConfig.estimatedDays as number | undefined,
    },
    now,
    now
  );

  const childStepInstance = await fastify.prisma.workflowStepInstance.create({
    data: {
      tenantId,
      workflowInstanceId: childInstance.id,
      stepDefinitionId: startStep.id,
      status: "active",
      startedAt: now,
      availableAt,
      dueAt,
    },
  });

  // 5. Log events
  await logEvent(
    fastify,
    tenantId,
    childInstance.id,
    childStepInstance.id,
    "workflow_started",
    {
      definitionCode: childDef.code,
      definitionName: childDef.name,
      parentWorkflowInstanceId: parentWorkflowInstance.id,
      parentStepInstanceId,
    }
  );

  await logEvent(
    fastify,
    tenantId,
    childInstance.id,
    childStepInstance.id,
    "step_activated",
    {
      stepDefinitionId: startStep.id,
      stepCode: startStep.code,
      stepName: startStep.name,
    }
  );

  // Fire on_enter actions for the start step (non-blocking)
  executeActions(fastify, tenantId, childStepInstance.id, "on_enter").catch(
    (err) => {
      fastify.log.error(
        { err, stepInstanceId: childStepInstance.id },
        "Failed to execute on_enter actions in child workflow"
      );
    }
  );

  return childInstance.id;
}

/**
 * When a child workflow completes (reaches terminal step), complete the parent
 * sub_workflow step and continue the parent workflow.
 *
 * Called from step-completion.ts after the child workflow is marked completed.
 */
export async function completeParentOnChildFinish(
  fastify: FastifyInstance,
  tenantId: string,
  childWorkflowInstance: {
    id: string;
    parentStepInstanceId: string | null;
    parentWorkflowInstanceId: string | null;
    contextJson: unknown;
  }
): Promise<void> {
  if (!childWorkflowInstance.parentStepInstanceId) return;

  // Load the parent step instance
  const parentStepInstance = await fastify.prisma.workflowStepInstance.findFirst(
    {
      where: {
        id: childWorkflowInstance.parentStepInstanceId,
        tenantId,
      },
      include: {
        stepDefinition: true,
        workflowInstance: true,
      },
    }
  );

  if (!parentStepInstance) {
    fastify.log.warn(
      { parentStepInstanceId: childWorkflowInstance.parentStepInstanceId },
      "Parent step instance not found for child workflow completion"
    );
    return;
  }

  if (parentStepInstance.status !== "waiting") {
    fastify.log.warn(
      {
        parentStepInstanceId: parentStepInstance.id,
        status: parentStepInstance.status,
      },
      "Parent step instance not in waiting status"
    );
    return;
  }

  const now = new Date();

  // Gather child workflow output (last completed step's output)
  const lastChildStep = await fastify.prisma.workflowStepInstance.findFirst({
    where: {
      workflowInstanceId: childWorkflowInstance.id,
      status: "completed",
    },
    orderBy: { completedAt: "desc" },
    select: { outputJson: true },
  });

  // Complete the parent step
  await fastify.prisma.workflowStepInstance.update({
    where: { id: parentStepInstance.id },
    data: {
      status: "completed",
      completedAt: now,
      outputJson: lastChildStep?.outputJson ?? undefined,
    },
  });

  await logEvent(
    fastify,
    tenantId,
    parentStepInstance.workflowInstanceId,
    parentStepInstance.id,
    "sub_workflow_completed",
    {
      childWorkflowInstanceId: childWorkflowInstance.id,
    }
  );

  // Fire on_complete actions for the parent step (non-blocking)
  executeActions(
    fastify,
    tenantId,
    parentStepInstance.id,
    "on_complete"
  ).catch((err) => {
    fastify.log.error(
      { err, stepInstanceId: parentStepInstance.id },
      "Failed to execute on_complete actions after sub-workflow"
    );
  });

  // Resolve transitions from the parent step to continue the parent workflow
  await resolveTransitions(
    fastify,
    tenantId,
    {
      id: parentStepInstance.id,
      stepDefinitionId: parentStepInstance.stepDefinitionId,
      outputJson: lastChildStep?.outputJson ?? null,
      workflowInstanceId: parentStepInstance.workflowInstanceId,
      itemContextJson: parentStepInstance.itemContextJson,
      spawnGroupId: parentStepInstance.spawnGroupId,
    },
    {
      id: parentStepInstance.workflowInstance.id,
      workflowDefinitionId:
        parentStepInstance.workflowInstance.workflowDefinitionId,
      contextJson: parentStepInstance.workflowInstance.contextJson,
      startedAt: parentStepInstance.workflowInstance.startedAt,
      entityId: parentStepInstance.workflowInstance.entityId,
      entityType: parentStepInstance.workflowInstance.entityType,
    }
  );
}
