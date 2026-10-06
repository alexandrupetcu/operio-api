import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { resolveTransitions } from "./transition-resolver.js";
import { logEvent, flushLogs } from "./execution-logger.js";
import { executeActions } from "./action-executor.js";
import { completeParentOnChildFinish } from "./sub-workflow.js";
import { triggerDocumentGeneration } from "./document-trigger.js";

/**
 * Complete a workflow step instance:
 * 1. Load step instance with its step definition and workflow instance
 * 2. Verify status is "active" or "waiting"
 * 3. Update step instance: status="completed", completedAt=now, outputJson=output
 * 4. Resolve transitions to find and create next steps
 * 5. Check if workflow should be marked complete (terminal step reached)
 * 6. Update workflow's currentStepCode
 * 7. Log events
 */
export async function completeStep(
  fastify: FastifyInstance,
  tenantId: string,
  stepInstanceId: string,
  userId: string,
  output?: unknown
): Promise<{ workflowCompleted: boolean; nextStepIds: string[] }> {
  const result = await fastify.prisma.$transaction(async (tx) => {
    // 1. Load step instance with related data
    const stepInstance = await tx.workflowStepInstance.findFirst({
      where: { id: stepInstanceId, tenantId },
      include: {
        stepDefinition: true,
        workflowInstance: true,
      },
    });

    if (!stepInstance) {
      throw fastify.httpErrors.notFound("Step instance not found");
    }

    // 2. Verify status
    if (stepInstance.status !== "active" && stepInstance.status !== "waiting") {
      throw fastify.httpErrors.badRequest(
        `Step instance cannot be completed in status "${stepInstance.status}". Must be "active" or "waiting".`
      );
    }

    const now = new Date();

    // 3. Update step instance
    await tx.workflowStepInstance.update({
      where: { id: stepInstanceId },
      data: {
        status: "completed",
        completedAt: now,
        outputJson: output !== undefined
          ? (output as Prisma.InputJsonValue)
          : undefined,
      },
    });

    // Use the main prisma client (not tx) for transition resolution since it calls prisma directly
    // We need to pass the transaction-level data but use fastify for resolveTransitions
    // Since resolveTransitions uses fastify.prisma, we create a wrapper
    const txFastify = Object.create(fastify) as FastifyInstance;
    Object.defineProperty(txFastify, "prisma", {
      value: tx,
      configurable: true,
    });
    // Log accumulator: batches all logEvent calls for a single createMany at the end
    const logAccumulator: Prisma.WorkflowExecutionLogUncheckedCreateInput[] = [];
    Object.defineProperty(txFastify, "_logAccumulator", {
      value: logAccumulator,
      configurable: true,
    });

    // 4. Check joinMode — if this step belongs to a spawn group, check
    // if all siblings need to complete before resolving outgoing transitions
    if (stepInstance.spawnGroupId) {
      const shouldWait = await checkJoinMode(
        tx,
        stepInstance.spawnGroupId,
        stepInstance.id,
        stepInstance.stepDefinitionId,
        stepInstance.workflowInstance.workflowDefinitionId
      );

      if (shouldWait) {
        // Not all siblings are complete yet — log and return without resolving transitions
        logAccumulator.push({
          tenantId,
          workflowInstanceId: stepInstance.workflowInstanceId,
          stepInstanceId: stepInstance.id,
          eventType: "join_waiting",
          payloadJson: {
            spawnGroupId: stepInstance.spawnGroupId,
            stepCode: stepInstance.stepDefinition?.code ?? null,
          } as Prisma.InputJsonValue,
        });
        await flushLogs(txFastify);

        return { workflowCompleted: false, nextStepIds: [] };
      }
    }

    // 5. Resolve transitions
    const nextStepIds = await resolveTransitions(
      txFastify,
      tenantId,
      {
        id: stepInstance.id,
        stepDefinitionId: stepInstance.stepDefinitionId,
        outputJson: output ?? stepInstance.outputJson,
        workflowInstanceId: stepInstance.workflowInstanceId,
        itemContextJson: stepInstance.itemContextJson,
        spawnGroupId: stepInstance.spawnGroupId,
      },
      {
        id: stepInstance.workflowInstance.id,
        workflowDefinitionId: stepInstance.workflowInstance.workflowDefinitionId,
        contextJson: stepInstance.workflowInstance.contextJson,
        startedAt: stepInstance.workflowInstance.startedAt,
        entityId: stepInstance.workflowInstance.entityId,
        entityType: stepInstance.workflowInstance.entityType,
      }
    );

    // 6. Check if any next step is terminal
    let workflowCompleted = false;
    // Single query for next step instances — reused for terminal check AND currentStepCode
    const nextStepInstances = nextStepIds.length > 0
      ? await tx.workflowStepInstance.findMany({
          where: { id: { in: nextStepIds } },
          include: { stepDefinition: true },
        })
      : [];

    // Next-step instances are always definition-backed (created from a toStep),
    // so stepDefinition is non-null here; optional-chain to satisfy the nullable type.
    const terminalStep = nextStepInstances.find(
      (si) => si.stepDefinition?.isTerminal && si.status !== "failed"
    );

    if (terminalStep) {
      workflowCompleted = true;

      // Auto-complete the terminal step
      await tx.workflowStepInstance.update({
        where: { id: terminalStep.id },
        data: {
          status: "completed",
          completedAt: now,
        },
      });

      // Mark workflow as completed
      await tx.workflowInstance.update({
        where: { id: stepInstance.workflowInstanceId },
        data: {
          status: "completed",
          completedAt: now,
          currentStepCode: terminalStep.stepDefinition?.code,
        },
      });

      logAccumulator.push({
        tenantId,
        workflowInstanceId: stepInstance.workflowInstanceId,
        stepInstanceId: terminalStep.id,
        eventType: "workflow_completed",
        payloadJson: {
          terminalStepCode: terminalStep.stepDefinition?.code ?? null,
        } as Prisma.InputJsonValue,
      });

      // Workflow-driven project status: when the workflow finishes, move the
      // attached project to the terminal step's configJson.projectStatus
      // (defaulting to "completed"). Only when the workflow is on a project.
      if (
        stepInstance.workflowInstance.entityType === "project" &&
        stepInstance.workflowInstance.entityId
      ) {
        const terminalCfg =
          terminalStep.stepDefinition?.configJson &&
          typeof terminalStep.stepDefinition.configJson === "object"
            ? (terminalStep.stepDefinition.configJson as Record<string, unknown>)
            : {};
        const finalStatus =
          typeof terminalCfg.projectStatus === "string" && terminalCfg.projectStatus.trim()
            ? terminalCfg.projectStatus.trim()
            : "completed";
        const project = await tx.project.findFirst({
          where: { id: stepInstance.workflowInstance.entityId, tenantId },
          select: { status: true },
        });
        if (project && project.status !== finalStatus) {
          await tx.project.update({
            where: { id: stepInstance.workflowInstance.entityId },
            data: { status: finalStatus },
          });
          logAccumulator.push({
            tenantId,
            workflowInstanceId: stepInstance.workflowInstanceId,
            stepInstanceId: terminalStep.id,
            eventType: "project_status_changed",
            payloadJson: { from: project.status, to: finalStatus } as Prisma.InputJsonValue,
          });
        }
      }
    }

    // 7. Update workflow's currentStepCode if not completed (reuse nextStepInstances)
    if (!workflowCompleted && nextStepInstances.length > 0) {
      const firstNextStep = nextStepInstances[0];
      await tx.workflowInstance.update({
        where: { id: stepInstance.workflowInstanceId },
        data: {
          currentStepCode: firstNextStep.stepDefinition?.code,
        },
      });
    }

    // 8. Log step completion event (batched)
    logAccumulator.push({
      tenantId,
      workflowInstanceId: stepInstance.workflowInstanceId,
      stepInstanceId: stepInstance.id,
      eventType: "step_completed",
      payloadJson: {
        stepCode: stepInstance.stepDefinition?.code ?? null,
        stepName: stepInstance.displayName ?? stepInstance.stepDefinition?.name ?? null,
        userId,
        nextStepIds,
        workflowCompleted,
      } as Prisma.InputJsonValue,
    });

    // Flush all accumulated logs in a single batch insert
    await flushLogs(txFastify);

    return {
      workflowCompleted,
      nextStepIds,
      workflowInstanceId: stepInstance.workflowInstanceId,
      parentStepInstanceId: stepInstance.workflowInstance.parentStepInstanceId,
      parentWorkflowInstanceId: stepInstance.workflowInstance.parentWorkflowInstanceId,
      workflowContextJson: stepInstance.workflowInstance.contextJson,
    };
  });

  // Fire backend on_complete actions after the transaction succeeds (non-blocking)
  executeActions(fastify, tenantId, stepInstanceId, "on_complete").catch((err) => {
    fastify.log.error({ err, stepInstanceId }, "Failed to execute on_complete actions");
  });

  // If the completed workflow is a child sub-workflow, complete the parent step
  if (result.workflowCompleted && result.parentStepInstanceId) {
    completeParentOnChildFinish(fastify, tenantId, {
      id: result.workflowInstanceId,
      parentStepInstanceId: result.parentStepInstanceId,
      parentWorkflowInstanceId: result.parentWorkflowInstanceId,
      contextJson: result.workflowContextJson,
    }).catch((err) => {
      fastify.log.error(
        { err, childWorkflowInstanceId: result.workflowInstanceId },
        "Failed to complete parent step after sub-workflow"
      );
    });
  }

  return result;
}

/**
 * Fail a workflow step instance.
 * Sets status to "failed", records error, and logs the event.
 */
export async function failStep(
  fastify: FastifyInstance,
  tenantId: string,
  stepInstanceId: string,
  userId: string,
  error?: unknown
): Promise<void> {
  return fastify.prisma.$transaction(async (tx) => {
    const stepInstance = await tx.workflowStepInstance.findFirst({
      where: { id: stepInstanceId, tenantId },
      include: {
        stepDefinition: true,
        workflowInstance: true,
      },
    });

    if (!stepInstance) {
      throw fastify.httpErrors.notFound("Step instance not found");
    }

    if (stepInstance.status !== "active" && stepInstance.status !== "waiting") {
      throw fastify.httpErrors.badRequest(
        `Step instance cannot be failed in status "${stepInstance.status}". Must be "active" or "waiting".`
      );
    }

    const now = new Date();

    // Update step instance to failed
    await tx.workflowStepInstance.update({
      where: { id: stepInstanceId },
      data: {
        status: "failed",
        completedAt: now,
        errorJson: error !== undefined
          ? (error as Prisma.InputJsonValue)
          : undefined,
      },
    });

    // Log step failure event
    await tx.workflowExecutionLog.create({
      data: {
        tenantId,
        workflowInstanceId: stepInstance.workflowInstanceId,
        stepInstanceId: stepInstance.id,
        eventType: "step_failed",
        payloadJson: {
          stepCode: stepInstance.stepDefinition?.code ?? null,
          stepName: stepInstance.displayName ?? stepInstance.stepDefinition?.name ?? null,
          userId,
          error: error ?? null,
        } as Prisma.InputJsonValue,
      },
    });
  });
}

/**
 * Step types that auto-complete synchronously after retry.
 * NOTE: "document_generation" handled separately — re-queues async jobs and waits.
 */
const AUTO_STEP_TYPES = new Set(["notification", "timer_wait", "system_action"]);

/**
 * Retry a failed step instance: reset status to "active", clear error, increment retry count.
 * For auto step types (notification, etc.), re-executes the step automatically
 * and completes it + resolves outgoing transitions.
 * For document_generation: re-queues async jobs and sets status to "waiting"; the worker
 * will complete or fail the step when documents finish.
 */
export async function retryStep(
  fastify: FastifyInstance,
  tenantId: string,
  stepInstanceId: string,
  userId: string
): Promise<{ autoCompleted: boolean }> {
  const result = await fastify.prisma.$transaction(async (tx) => {
    const stepInstance = await tx.workflowStepInstance.findFirst({
      where: { id: stepInstanceId, tenantId },
      include: {
        stepDefinition: true,
        workflowInstance: true,
      },
    });

    if (!stepInstance) {
      throw fastify.httpErrors.notFound("Step instance not found");
    }

    if (stepInstance.status !== "failed") {
      throw fastify.httpErrors.badRequest(
        `Step instance cannot be retried in status "${stepInstance.status}". Must be "failed".`
      );
    }

    const now = new Date();

    await tx.workflowStepInstance.update({
      where: { id: stepInstanceId },
      data: {
        status: "active",
        completedAt: null,
        errorJson: Prisma.JsonNull,
        retryCount: { increment: 1 },
        startedAt: now,
      },
    });

    await tx.workflowExecutionLog.create({
      data: {
        tenantId,
        workflowInstanceId: stepInstance.workflowInstanceId,
        stepInstanceId: stepInstance.id,
        eventType: "step_retried",
        payloadJson: {
          stepCode: stepInstance.stepDefinition?.code ?? null,
          stepName: stepInstance.displayName ?? stepInstance.stepDefinition?.name ?? null,
          userId,
          retryCount: stepInstance.retryCount + 1,
        } as Prisma.InputJsonValue,
      },
    });

    return {
      stepType: stepInstance.stepDefinition?.stepType ?? "human_task",
      stepConfig: (stepInstance.stepDefinition?.configJson ?? {}) as Record<string, unknown>,
      workflowInstanceId: stepInstance.workflowInstanceId,
      entityId: stepInstance.workflowInstance.entityId,
      entityType: stepInstance.workflowInstance.entityType,
    };
  });

  // For document_generation: re-queue jobs and set step to "waiting"
  // (worker will complete or fail it when documents finish)
  if (result.stepType === "document_generation") {
    const success = await triggerDocumentGeneration(
      fastify,
      tenantId,
      stepInstanceId,
      {
        id: result.workflowInstanceId,
        entityId: result.entityId,
        entityType: result.entityType,
      },
      result.stepConfig
    );
    if (!success) {
      // triggerDocumentGeneration already marked the step as failed again
      return { autoCompleted: false };
    }
    await fastify.prisma.workflowStepInstance.update({
      where: { id: stepInstanceId },
      data: { status: "waiting" },
    });
    return { autoCompleted: false };
  }

  // For synchronous auto step types, re-execute logic then complete
  if (AUTO_STEP_TYPES.has(result.stepType)) {
    await completeStep(fastify, tenantId, stepInstanceId, userId);
    return { autoCompleted: true };
  }

  return { autoCompleted: false };
}

/**
 * Check if a spawned step should wait for siblings before resolving transitions.
 *
 * Looks at outgoing transitions from the step's definition to find the next step.
 * If the next step has joinMode="all", checks if all siblings in the spawn group
 * are complete. Returns true if the step should WAIT (not resolve transitions yet).
 * Returns false if transitions should be resolved normally.
 */
async function checkJoinMode(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  spawnGroupId: string,
  currentStepInstanceId: string,
  stepDefinitionId: string | null,
  workflowDefinitionId: string
): Promise<boolean> {
  // Find outgoing transitions from this step definition
  const outgoing = await (tx as any).workflowTransition.findMany({
    where: {
      workflowDefinitionId,
      fromStepId: stepDefinitionId,
    },
    include: { toStep: true },
  });

  // Check if any target step has joinMode
  const joinStep = outgoing.find(
    (t: any) => t.toStep.joinMode === "all" || t.toStep.joinMode === "any"
  );

  if (!joinStep) {
    // No join step — proceed normally
    return false;
  }

  const joinMode = joinStep.toStep.joinMode as string;

  if (joinMode === "any") {
    // "any" mode: first completion triggers the join — never wait
    return false;
  }

  // joinMode === "all": check if ALL siblings of the SAME step definition are now complete.
  // We filter by stepDefinitionId so that downstream steps in the same spawnGroup (e.g.
  // "Ridica aviz" instances created after "Depune cerere" completes) are NOT counted as
  // siblings of "Depune cerere" — their presence would otherwise block fan-out.
  const siblings = await (tx as any).workflowStepInstance.findMany({
    where: { spawnGroupId, stepDefinitionId },
    select: { id: true, status: true },
  });

  const allComplete = siblings.every(
    (s: { id: string; status: string }) =>
      s.status === "completed" || s.id === currentStepInstanceId
  );

  // If not all complete, wait
  return !allComplete;
}
