import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { redisConnection } from "../../config/redis.js";
import { evaluateCondition } from "./condition-evaluator.js";
import { calculateDeadlines } from "./deadline-calculator.js";
import { logEvent } from "./execution-logger.js";
import { isTenantEventEnabled } from "../../modules/notifications/tenant-settings.js";
import { dispatchWorkflowEvent } from "../../modules/notifications/dispatch.js";
import { executeActions } from "./action-executor.js";
import { spawnSubWorkflow } from "./sub-workflow.js";
import { triggerDocumentGeneration } from "./document-trigger.js";
import { applyStepProjectStatus } from "./project-status-sync.js";

/** Shared BullMQ queue for engine-level delayed jobs (reminders, activations, etc.) */
const workflowQueue = new Queue("workflow-engine", { connection: redisConnection });

/**
 * Schedule the `mark_step_overdue` delayed job for a step instance with a future
 * dueAt. The worker (handleMarkStepOverdue) skips if the step is already
 * completed/cancelled or if dueAt changed since. Shared by the transition
 * resolver and the ad-hoc-step service so both use the same queue instance.
 */
export async function scheduleStepOverdue(
  stepInstanceId: string,
  tenantId: string,
  dueAt: Date,
  now: Date = new Date()
): Promise<void> {
  if (dueAt.getTime() <= now.getTime()) return;
  await workflowQueue.add(
    "mark_step_overdue",
    { type: "mark_step_overdue", tenantId, workflowStepInstanceId: stepInstanceId },
    { delay: dueAt.getTime() - now.getTime(), removeOnComplete: 100, removeOnFail: 100 }
  );
}

/**
 * Step types that auto-complete synchronously without user interaction.
 *
 * NOTE: "document_generation" is NOT in this set anymore — it now waits for
 * asynchronous BullMQ jobs to finish. The document-generation worker calls
 * completeStep / failStep when all documents reach a terminal status.
 */
const AUTO_STEP_TYPES = new Set(["notification", "timer_wait", "system_action"]);

interface CompletedStepInstance {
  id: string;
  /** null for ad-hoc steps — yields no outgoing transitions (dead-end). */
  stepDefinitionId: string | null;
  outputJson: unknown;
  workflowInstanceId: string;
  /** Inherited item context from a foreach-spawned parent — propagates through the chain */
  itemContextJson?: unknown;
  /** Spawn group from a foreach transition — propagates through the entire item chain */
  spawnGroupId?: string | null;
}

interface WorkflowInstanceRef {
  id: string;
  workflowDefinitionId: string;
  contextJson: unknown;
  startedAt: Date;
  entityId?: string | null;
  entityType?: string | null;
}

/**
 * Resolve transitions from a completed step instance:
 * 1. Load all transitions FROM the completed step's definition, ordered by priority DESC
 * 2. Evaluate conditions for each transition
 * 3. Create new WorkflowStepInstance records for matched transitions
 * 4. Return IDs of created step instances
 */
export async function resolveTransitions(
  fastify: FastifyInstance,
  tenantId: string,
  completedStepInstance: CompletedStepInstance,
  workflowInstance: WorkflowInstanceRef,
  cache: Map<string, unknown> = new Map()
): Promise<string[]> {
  // Ad-hoc steps (no definition) have no outgoing transitions — dead-end.
  if (!completedStepInstance.stepDefinitionId) {
    return [];
  }

  // 1. Load all transitions FROM the completed step's definition
  const transitions = await fastify.prisma.workflowTransition.findMany({
    where: {
      workflowDefinitionId: workflowInstance.workflowDefinitionId,
      fromStepId: completedStepInstance.stepDefinitionId,
    },
    include: {
      toStep: true,
    },
    orderBy: {
      priority: "desc",
    },
  });

  if (transitions.length === 0) {
    return [];
  }

  // Load inherited item context and spawnGroupId from the completing step instance
  let inheritedItemContext: unknown | null = completedStepInstance.itemContextJson ?? null;
  let inheritedSpawnGroupId: string | null = completedStepInstance.spawnGroupId ?? null;
  if (inheritedItemContext === undefined || completedStepInstance.spawnGroupId === undefined) {
    // Fetch from DB if not provided in the caller
    const stepInstanceRecord = await fastify.prisma.workflowStepInstance.findUnique({
      where: { id: completedStepInstance.id },
      select: { itemContextJson: true, spawnGroupId: true },
    });
    inheritedItemContext = stepInstanceRecord?.itemContextJson ?? null;
    inheritedSpawnGroupId = stepInstanceRecord?.spawnGroupId ?? null;
  }

  // Build evaluation context from step output + workflow context + inherited item context
  const context: Record<string, unknown> = {
    ...(typeof workflowInstance.contextJson === "object" && workflowInstance.contextJson !== null
      ? (workflowInstance.contextJson as Record<string, unknown>)
      : {}),
    step_output:
      typeof completedStepInstance.outputJson === "object" &&
      completedStepInstance.outputJson !== null
        ? completedStepInstance.outputJson
        : {},
    // Include inherited item context in evaluation context (e.g. filing.institution)
    ...(typeof inheritedItemContext === "object" && inheritedItemContext !== null
      ? (inheritedItemContext as Record<string, unknown>)
      : {}),
  };

  // Enrich context with project data when workflow is attached to a project entity
  if (workflowInstance.entityType === "project" && workflowInstance.entityId) {
    const cacheKey = `project:${workflowInstance.entityId}`;
    let project = cache.get(cacheKey) as Record<string, unknown> | undefined;
    if (!project) {
      const result = await fastify.prisma.project.findFirst({
        where: { id: workflowInstance.entityId, tenantId },
        select: {
          id: true,
          name: true,
          status: true,
          priority: true,
          city: true,
          county: true,
          address: true,
          participareISC: true,
          observations: true,
          scheduledDate: true,
          projectTypeId: true,
          clientId: true,
          distributorId: true,
        },
      });
      if (result) {
        project = result as unknown as Record<string, unknown>;
        cache.set(cacheKey, project);
      }
    }
    if (project) context.project = project;
  }

  // 2. Evaluate each transition
  const matchedTransitions: Array<typeof transitions[number]> = [];

  for (const transition of transitions) {
    const type = transition.transitionType;

    if (type === "failure" || type === "timeout") {
      // Skip - these are handled separately
      continue;
    }

    if (type === "default" || type === "success") {
      // Always matches
      matchedTransitions.push(transition);
      continue;
    }

    if (type === "conditional") {
      const matches = evaluateCondition(transition.conditionJson, context);
      if (matches) {
        matchedTransitions.push(transition);
      }
      continue;
    }

    if (type === "manual") {
      // Manual transitions are triggered explicitly, skip during auto-resolution
      continue;
    }
  }

  // 3. Create step instances for matched transitions
  const now = new Date();
  const createdIds: string[] = [];

  for (const transition of matchedTransitions) {
    const toStep = transition.toStep;

    // Determine if this is a foreach transition
    if (transition.spawnMode === "foreach" && transition.foreachPath) {
      const ids = await spawnForeachInstances(
        fastify, tenantId, transition, toStep,
        completedStepInstance, workflowInstance, context, now, cache
      );
      createdIds.push(...ids);
      continue;
    }

    // Single spawn (default) — propagate inherited item context and spawnGroupId from foreach chain
    const ids = await createAndActivateStepInstance(
      fastify, tenantId, toStep, transition,
      completedStepInstance, workflowInstance, now,
      inheritedSpawnGroupId, inheritedItemContext as Record<string, unknown> | null, cache
    );
    createdIds.push(...ids);
  }

  return createdIds;
}

/**
 * Create a single step instance, activate it, handle auto-execution,
 * and recursively resolve transitions if auto-completed.
 */
async function createAndActivateStepInstance(
  fastify: FastifyInstance,
  tenantId: string,
  toStep: { id: string; code: string; name: string; stepType: string; configJson: unknown; nameTemplate?: string | null },
  transition: { id: string; transitionType: string },
  completedStepInstance: CompletedStepInstance,
  workflowInstance: WorkflowInstanceRef,
  now: Date,
  spawnGroupId: string | null,
  itemContext: Record<string, unknown> | null,
  cache: Map<string, unknown> = new Map()
): Promise<string[]> {
  const createdIds: string[] = [];

  // Calculate deadlines — for foreach items, override estimatedDays from item context if present
  let stepConfig = toStep.configJson;
  if (itemContext && typeof itemContext === "object" && itemContext !== null) {
    const item = itemContext as Record<string, unknown>;
    if (item.deadlineDays || item.estimatedDays) {
      stepConfig = {
        ...(typeof toStep.configJson === "object" && toStep.configJson !== null
          ? (toStep.configJson as Record<string, unknown>)
          : {}),
        estimatedDays: item.deadlineDays ?? item.estimatedDays,
      };
    }
  }

  const { availableAt, dueAt } = calculateDeadlines(
    stepConfig,
    now,
    workflowInstance.startedAt
  );

  // Resolve name template if present (e.g. "Depune cerere la {{filing.institution}}")
  const displayName = toStep.nameTemplate && itemContext
    ? resolveNameTemplate(toStep.nameTemplate, itemContext)
    : null;

  const stepInstance = await fastify.prisma.workflowStepInstance.create({
    data: {
      tenantId,
      workflowInstanceId: workflowInstance.id,
      stepDefinitionId: toStep.id,
      status: "active",
      startedAt: now,
      availableAt,
      dueAt,
      displayName,
      spawnGroupId,
      itemContextJson: itemContext !== null
        ? (itemContext as Prisma.InputJsonValue)
        : undefined,
    },
  });

  createdIds.push(stepInstance.id);

  // Schedule overdue transition when the step has a future dueAt.
  if (dueAt) {
    await scheduleStepOverdue(stepInstance.id, tenantId, dueAt, now);
  }

  // Log step activation
  await logEvent(
    fastify,
    tenantId,
    workflowInstance.id,
    stepInstance.id,
    "step_activated",
    {
      stepDefinitionId: toStep.id,
      stepCode: toStep.code,
      stepName: toStep.name,
      transitionId: transition.id,
      transitionType: transition.transitionType,
      fromStepInstanceId: completedStepInstance.id,
      ...(spawnGroupId ? { spawnGroupId } : {}),
      ...(itemContext !== null ? { itemContext } : {}),
    }
  );

  // Workflow-driven project status: if this step declares configJson.projectStatus,
  // move the attached project to that status on activation.
  await applyStepProjectStatus(
    fastify,
    tenantId,
    {
      entityType: workflowInstance.entityType,
      entityId: workflowInstance.entityId,
      workflowInstanceId: workflowInstance.id,
    },
    toStep.configJson,
    stepInstance.id,
  );

  // Fire backend on_enter actions (non-blocking)
  executeActions(fastify, tenantId, stepInstance.id, "on_enter").catch((err) => {
    fastify.log.error({ err, stepInstanceId: stepInstance.id }, "Failed to execute on_enter actions");
  });

  // Build template context for notification placeholders
  // Merges: workflow context + step output + item context (if foreach)
  const templateContext = buildTemplateContext(workflowInstance, completedStepInstance, itemContext);

  // 4a. Fire on_activation notifications for manual steps
  if (!AUTO_STEP_TYPES.has(toStep.stepType)) {
    await fireActivationNotifications(
      fastify, tenantId, toStep, stepInstance, workflowInstance, now, templateContext
    );
  }

  // 4b. Handle sub_workflow step: spawn child workflow, set parent to "waiting"
  if (toStep.stepType === "sub_workflow") {
    const subDefId = (toStep.configJson as Record<string, unknown>)?.subWorkflowDefinitionId as string | undefined;
    if (subDefId) {
      await spawnSubWorkflow(
        fastify,
        tenantId,
        stepInstance.id,
        workflowInstance,
        subDefId,
        itemContext
      );
      // Set step to waiting (don't auto-complete)
      await fastify.prisma.workflowStepInstance.update({
        where: { id: stepInstance.id },
        data: { status: "waiting" },
      });
      await logEvent(
        fastify,
        tenantId,
        workflowInstance.id,
        stepInstance.id,
        "sub_workflow_spawned",
        { subWorkflowDefinitionId: subDefId }
      );
      // Don't fall through to auto-complete — child workflow will callback
      return createdIds;
    }
  }

  // 4c. document_generation — queue jobs and WAIT for worker to complete the step
  if (toStep.stepType === "document_generation") {
    const cfg = (toStep.configJson ?? {}) as Record<string, unknown>;
    const success = await triggerDocumentGeneration(
      fastify,
      tenantId,
      stepInstance.id,
      workflowInstance,
      cfg
    );
    if (!success) {
      // triggerDocumentGeneration already marked step as failed — nothing more to do
      return createdIds;
    }

    // Move step to "waiting" — the document-generation worker will call
    // completeStep/failStep when all documents reach a terminal status.
    await fastify.prisma.workflowStepInstance.update({
      where: { id: stepInstance.id },
      data: { status: "waiting" },
    });

    await logEvent(
      fastify,
      tenantId,
      workflowInstance.id,
      stepInstance.id,
      "step_waiting_for_documents",
      { stepCode: toStep.code }
    );

    return createdIds;
  }

  // 4d. Auto-execute automatic step types (synchronous)
  if (AUTO_STEP_TYPES.has(toStep.stepType)) {
    const cfg = (toStep.configJson ?? {}) as Record<string, unknown>;

    // Execute step-type-specific logic
    if (toStep.stepType === "notification") {
      await executeNotificationStep(
        fastify,
        tenantId,
        cfg,
        stepInstance.id,
        completedStepInstance,
        workflowInstance,
        toStep,
        now,
        templateContext
      );
    }

    // Auto-complete the step
    await fastify.prisma.workflowStepInstance.update({
      where: { id: stepInstance.id },
      data: { status: "completed", completedAt: now },
    });

    await logEvent(
      fastify,
      tenantId,
      workflowInstance.id,
      stepInstance.id,
      "step_auto_completed",
      {
        stepCode: toStep.code,
        stepType: toStep.stepType,
      }
    );

    // Recursively resolve transitions from the auto-completed step
    // Propagate item context and spawnGroupId through auto-completed steps (e.g. timer → next manual step)
    const nextIds = await resolveTransitions(
      fastify,
      tenantId,
      {
        id: stepInstance.id,
        stepDefinitionId: toStep.id,
        outputJson: null,
        workflowInstanceId: workflowInstance.id,
        itemContextJson: itemContext,
        spawnGroupId,
      },
      workflowInstance,
      cache
    );
    createdIds.push(...nextIds);
  }

  return createdIds;
}

/**
 * Foreach spawn: read an array from the completed step's output,
 * create one step instance per item with a shared spawnGroupId.
 */
async function spawnForeachInstances(
  fastify: FastifyInstance,
  tenantId: string,
  transition: { id: string; transitionType: string; foreachPath: string | null; itemContextKey: string | null },
  toStep: { id: string; code: string; name: string; stepType: string; configJson: unknown; nameTemplate?: string | null },
  completedStepInstance: CompletedStepInstance,
  workflowInstance: WorkflowInstanceRef,
  context: Record<string, unknown>,
  now: Date,
  cache: Map<string, unknown> = new Map()
): Promise<string[]> {
  const foreachPath = transition.foreachPath ?? "";
  const itemKey = transition.itemContextKey ?? "item";

  // Resolve the array from the step output using dot-path
  const output = (context.step_output ?? {}) as Record<string, unknown>;
  const items = resolvePath(output, foreachPath);

  if (!Array.isArray(items) || items.length === 0) {
    console.warn(
      `Foreach transition ${transition.id}: path "${foreachPath}" did not resolve to a non-empty array, skipping`
    );
    return [];
  }

  const spawnGroupId = randomUUID();
  const createdIds: string[] = [];

  await logEvent(
    fastify, tenantId, workflowInstance.id, null,
    "foreach_spawn_started",
    {
      transitionId: transition.id,
      foreachPath,
      itemCount: items.length,
      spawnGroupId,
      targetStepCode: toStep.code,
    }
  );

  for (const item of items) {
    const itemContext = { [itemKey]: item };
    const ids = await createAndActivateStepInstance(
      fastify, tenantId, toStep, transition,
      completedStepInstance, workflowInstance, now,
      spawnGroupId, itemContext, cache
    );
    createdIds.push(...ids);
  }

  return createdIds;
}

/**
 * Build a merged context object for resolving {{placeholders}} in notification templates.
 * Includes: workflow context, step output, and per-item context (for foreach instances).
 */
function buildTemplateContext(
  workflowInstance: WorkflowInstanceRef,
  completedStepInstance: CompletedStepInstance,
  itemContext: unknown | null
): Record<string, unknown> {
  return {
    // Workflow-level context
    ...(typeof workflowInstance.contextJson === "object" && workflowInstance.contextJson !== null
      ? (workflowInstance.contextJson as Record<string, unknown>)
      : {}),
    // Step output
    step_output:
      typeof completedStepInstance.outputJson === "object" && completedStepInstance.outputJson !== null
        ? completedStepInstance.outputJson
        : {},
    // Item context from foreach (e.g. { filing: { institution: "ANAF", ... } })
    ...(typeof itemContext === "object" && itemContext !== null
      ? (itemContext as Record<string, unknown>)
      : {}),
  };
}

/**
 * Resolve a name template by replacing {{key.path}} placeholders
 * with values from the item context.
 * E.g. "Depune cerere la {{filing.institution}}" with context
 * { filing: { institution: "ANAF" } } → "Depune cerere la ANAF"
 */
function resolveNameTemplate(template: string, context: unknown): string {
  const ctx = typeof context === "object" && context !== null
    ? (context as Record<string, unknown>)
    : {};
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
    const value = resolvePath(ctx, path.trim());
    return value !== undefined && value !== null ? String(value) : "";
  });
}

/** Resolve a dot-separated path on an object, e.g. "a.b.c" → obj.a.b.c */
function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((cur, key) => {
    if (cur && typeof cur === "object" && key in (cur as Record<string, unknown>)) {
      return (cur as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * When a manual step is activated, check if it has outgoing transitions to
 * notification steps with trigger=on_activation and fire those immediately.
 */
async function fireActivationNotifications(
  fastify: FastifyInstance,
  tenantId: string,
  activatedStep: { id: string; code: string },
  stepInstance: { id: string },
  workflowInstance: WorkflowInstanceRef,
  now: Date,
  templateContext: Record<string, unknown>
) {
  // Tenant-level switch: firm-wide mute for workflow notifications.
  if (!(await isTenantEventEnabled(fastify.prisma, tenantId, "workflow_events"))) return;

  const outgoing = await fastify.prisma.workflowTransition.findMany({
    where: {
      workflowDefinitionId: workflowInstance.workflowDefinitionId,
      fromStepId: activatedStep.id,
    },
    include: { toStep: true },
  });

  for (const transition of outgoing) {
    if (transition.toStep.stepType !== "notification") continue;

    const cfg = (transition.toStep.configJson ?? {}) as Record<string, unknown>;
    if (cfg.trigger !== "on_activation") continue;

    // Resolve {{placeholders}} in subject and body
    const rawSubject = (cfg.subject as string) ?? null;
    const rawBody = (cfg.body as string) ?? "Workflow notification";
    const subject = rawSubject ? resolveNameTemplate(rawSubject, templateContext) : null;
    const body = resolveNameTemplate(rawBody, templateContext);

    await dispatchWorkflowEvent(fastify.prisma, tenantId, {
      category: "projects",
      subject: subject ?? "Notificare workflow",
      body,
      url: workflowInstance.entityId ? `/projects/${workflowInstance.entityId}` : "/dashboard",
      projectId: workflowInstance.entityId ?? null,
      workflowInstanceId: workflowInstance.id,
    });

    await logEvent(
      fastify, tenantId, workflowInstance.id, stepInstance.id,
      "activation_notification_sent",
      { stepCode: activatedStep.code, notificationStepId: transition.toStep.id }
    );
  }
}

/**
 * Execute a notification step based on its trigger type.
 * - on_completion: send immediately (transition just resolved = parent completed)
 * - on_activation: send immediately (handled here because the parent step
 *   activation already resolved this transition)
 * - before_deadline: schedule reminders X days before the parent step deadline
 * - on_overdue: schedule a notification at the parent step's deadline
 */
async function executeNotificationStep(
  fastify: FastifyInstance,
  tenantId: string,
  stepConfig: Record<string, unknown>,
  stepInstanceId: string,
  completedStepInstance: CompletedStepInstance,
  workflowInstance: WorkflowInstanceRef,
  toStep: { id: string; code: string; configJson: unknown },
  now: Date,
  templateContext: Record<string, unknown>
) {
  // Skip if notification is disabled
  if (stepConfig.enabled === false) {
    return;
  }

  // Tenant-level switch: firm-wide mute for workflow notifications.
  if (!(await isTenantEventEnabled(fastify.prisma, tenantId, "workflow_events"))) {
    return;
  }

  const trigger = (stepConfig.trigger as string) ?? "on_completion";
  const channel = (stepConfig.channel as string) ?? "in_app";

  // Resolve {{placeholders}} in subject and body from template context
  const rawSubject = (stepConfig.subject as string) ?? null;
  const rawBody = (stepConfig.body as string) ?? "Workflow notification";
  const subject = rawSubject ? resolveNameTemplate(rawSubject, templateContext) : null;
  const body = resolveNameTemplate(rawBody, templateContext);

  const projectId = workflowInstance.entityId ?? null;

  // Immediate triggers: on_completion, on_activation
  if (trigger === "on_completion" || trigger === "on_activation") {
    await dispatchWorkflowEvent(fastify.prisma, tenantId, {
      category: "projects",
      subject: subject ?? "Notificare workflow",
      body,
      url: projectId ? `/projects/${projectId}` : "/dashboard",
      projectId,
      workflowInstanceId: workflowInstance.id,
    });
    return;
  }

  // Deadline-based triggers need the parent step's deadline
  const parentStepInstance = await fastify.prisma.workflowStepInstance.findFirst({
    where: { id: completedStepInstance.id },
    select: { dueAt: true },
  });

  // Also check next step deadline as fallback
  let deadlineDate = parentStepInstance?.dueAt ?? null;

  if (!deadlineDate) {
    // Try to derive from the connected step's config (estimatedDays)
    const reminderRef = (stepConfig.reminderRef as string) ?? "previous_step";
    if (reminderRef === "next_step") {
      const nextTransitions = await fastify.prisma.workflowTransition.findMany({
        where: {
          workflowDefinitionId: workflowInstance.workflowDefinitionId,
          fromStepId: toStep.id,
        },
        include: { toStep: true },
      });
      for (const nt of nextTransitions) {
        const { dueAt: nextDue } = calculateDeadlines(
          nt.toStep.configJson,
          now,
          workflowInstance.startedAt
        );
        if (nextDue) {
          deadlineDate = nextDue;
          break;
        }
      }
    }
  }

  if (!deadlineDate) {
    // No deadline found — fall back to sending immediately
    await dispatchWorkflowEvent(fastify.prisma, tenantId, {
      category: "projects",
      subject: subject ?? "Notificare workflow",
      body,
      url: projectId ? `/projects/${projectId}` : "/dashboard",
      projectId,
      workflowInstanceId: workflowInstance.id,
    });
    return;
  }

  const basePayload = {
    workflowInstanceId: workflowInstance.id,
    projectId,
    channel,
    subject,
    body,
  };

  if (trigger === "before_deadline") {
    const startDaysBefore = (stepConfig.reminderStartDaysBefore as number) ?? 3;
    const intervalHours = (stepConfig.reminderIntervalHours as number) ?? 24;
    const startMs = deadlineDate.getTime() - startDaysBefore * 24 * 60 * 60 * 1000;
    const intervalMs = intervalHours * 60 * 60 * 1000;
    const startTime = Math.max(startMs, now.getTime());

    for (let t = startTime; t < deadlineDate.getTime(); t += intervalMs) {
      await workflowQueue.add(
        "send_reminder",
        {
          type: "send_reminder",
          tenantId,
          workflowInstanceId: basePayload.workflowInstanceId,
          projectId: basePayload.projectId,
          channel: basePayload.channel,
          subject: basePayload.subject,
          body: basePayload.body,
        },
        { delay: Math.max(0, t - now.getTime()), removeOnComplete: 100, removeOnFail: 100 }
      );
    }

    await logEvent(fastify, tenantId, workflowInstance.id, stepInstanceId, "reminders_scheduled", {
      trigger,
      deadlineDate: deadlineDate.toISOString(),
      startDaysBefore,
      intervalHours,
    });
  } else if (trigger === "on_overdue") {
    // Schedule a notification at exactly the deadline
    await workflowQueue.add(
      "send_reminder",
      {
        type: "send_reminder",
        tenantId,
        workflowInstanceId: basePayload.workflowInstanceId,
        projectId: basePayload.projectId,
        channel: basePayload.channel,
        subject: basePayload.subject,
        body: basePayload.body,
      },
      {
        delay: Math.max(0, deadlineDate.getTime() - now.getTime()),
        removeOnComplete: 100,
        removeOnFail: 100,
      }
    );

    // If repeat is enabled, schedule additional notifications after the deadline
    if (stepConfig.reminderEnabled) {
      const intervalHours = (stepConfig.reminderIntervalHours as number) ?? 24;
      const intervalMs = intervalHours * 60 * 60 * 1000;
      // Schedule repeats for up to 30 days after deadline
      const maxRepeatEnd = deadlineDate.getTime() + 30 * 24 * 60 * 60 * 1000;
      for (let t = deadlineDate.getTime() + intervalMs; t < maxRepeatEnd; t += intervalMs) {
        await workflowQueue.add(
          "send_reminder",
          {
            type: "send_reminder",
            tenantId,
            workflowInstanceId: basePayload.workflowInstanceId,
            projectId: basePayload.projectId,
            channel: basePayload.channel,
            subject: basePayload.subject,
            body: basePayload.body,
          },
          { delay: Math.max(0, t - now.getTime()), removeOnComplete: 100, removeOnFail: 100 }
        );
      }

      await logEvent(fastify, tenantId, workflowInstance.id, stepInstanceId, "overdue_reminders_scheduled", {
        trigger,
        deadlineDate: deadlineDate.toISOString(),
        intervalHours,
      });
    }
  }
}
