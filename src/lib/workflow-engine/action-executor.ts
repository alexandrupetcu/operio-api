import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { Queue } from "bullmq";
import { redisConnection } from "../../config/redis.js";
import { isTenantEventEnabled } from "../../modules/notifications/tenant-settings.js";
import { dispatchWorkflowEvent } from "../../modules/notifications/dispatch.js";

/** Frontend-only triggers that should not be auto-executed by the engine */
const FRONTEND_TRIGGERS = new Set(["on_field_change", "on_file_upload"]);

/** Shared BullMQ queue for engine-level delayed jobs */
const workflowQueue = new Queue("workflow-engine", { connection: redisConnection });

interface ActionConfig {
  // create_task
  title?: string;
  description?: string;
  taskType?: string;
  priority?: string;
  assignedUserId?: string;
  dueDays?: number;

  // schedule_timer
  jobType?: string;
  delayMinutes?: number;
  delayHours?: number;
  delayDays?: number;

  // send_notification
  channel?: string;
  subject?: string;
  body?: string;
  userId?: string;
  clientId?: string;

  // update_project_status
  status?: string;

  // call_api
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  bodyTemplate?: unknown;
  responseMapping?: Array<{
    sourcePath: string;
    targetFieldKey: string;
    mappingType?: string;
  }>;
}

/**
 * Execute actions associated with a workflow step for a given trigger event.
 *
 * Loads WorkflowStepAction records for the step definition + trigger event,
 * then dispatches each action based on its actionType.
 */
export async function executeActions(
  fastify: FastifyInstance,
  tenantId: string,
  stepInstanceId: string,
  triggerEvent: string
): Promise<void> {
  // Load the step instance with its definition
  const stepInstance = await fastify.prisma.workflowStepInstance.findFirst({
    where: { id: stepInstanceId, tenantId },
    include: {
      stepDefinition: {
        include: {
          actions: {
            where: { triggerEvent },
          },
        },
      },
      workflowInstance: true,
    },
  });

  if (!stepInstance) {
    fastify.log.warn(
      { stepInstanceId, tenantId },
      "Step instance not found for action execution"
    );
    return;
  }

  // Ad-hoc steps have no definition and therefore no actions to execute.
  if (!stepInstance.stepDefinition) {
    return;
  }

  // Filter out frontend-only triggers — those are handled via the proxy endpoint
  const actions = stepInstance.stepDefinition.actions.filter(
    (a) => !FRONTEND_TRIGGERS.has(a.triggerEvent)
  );
  if (actions.length === 0) {
    return;
  }

  for (const action of actions) {
    const config = (action.actionConfigJson ?? {}) as ActionConfig;

    try {
      switch (action.actionType) {
        case "create_task":
          await createTask(fastify, tenantId, stepInstance, config);
          break;

        case "schedule_timer":
          await scheduleTimer(fastify, tenantId, stepInstance, config);
          break;

        case "send_notification":
          await sendNotification(fastify, tenantId, stepInstance, config);
          break;

        case "update_project_status":
          await updateProjectStatus(fastify, tenantId, stepInstance, config);
          break;

        case "call_api":
          await callApi(fastify, tenantId, stepInstance, config);
          break;

        default:
          fastify.log.warn(
            { actionType: action.actionType, actionId: action.id },
            "Unknown action type - skipping (extensibility point)"
          );
          break;
      }
    } catch (err) {
      fastify.log.error(
        { err, actionId: action.id, actionType: action.actionType },
        "Failed to execute workflow step action"
      );
    }
  }
}

async function createTask(
  fastify: FastifyInstance,
  tenantId: string,
  stepInstance: {
    id: string;
    workflowInstanceId: string;
    workflowInstance: { entityId: string };
  },
  config: ActionConfig
): Promise<void> {
  const dueAt =
    config.dueDays !== undefined
      ? new Date(Date.now() + config.dueDays * 24 * 60 * 60 * 1000)
      : null;

  await fastify.prisma.task.create({
    data: {
      tenantId,
      projectId: stepInstance.workflowInstance.entityId,
      workflowInstanceId: stepInstance.workflowInstanceId,
      workflowStepInstanceId: stepInstance.id,
      title: config.title ?? "Workflow task",
      description: config.description ?? null,
      taskType: config.taskType ?? "workflow_generated",
      priority: config.priority ?? "normal",
      assignedUserId: config.assignedUserId ?? null,
      dueAt,
      status: "open",
    },
  });
}

async function scheduleTimer(
  fastify: FastifyInstance,
  tenantId: string,
  stepInstance: {
    id: string;
    workflowInstanceId: string;
  },
  config: ActionConfig
): Promise<void> {
  let delayMs = 0;
  if (config.delayMinutes) delayMs += config.delayMinutes * 60 * 1000;
  if (config.delayHours) delayMs += config.delayHours * 60 * 60 * 1000;
  if (config.delayDays) delayMs += config.delayDays * 24 * 60 * 60 * 1000;

  // Default to 1 hour if no delay specified
  if (delayMs === 0) delayMs = 60 * 60 * 1000;

  const jobType = config.jobType ?? "activate_step";

  await workflowQueue.add(
    jobType,
    {
      type: jobType,
      tenantId,
      workflowStepInstanceId: stepInstance.id,
      workflowInstanceId: stepInstance.workflowInstanceId,
    },
    { delay: delayMs, removeOnComplete: 100, removeOnFail: 100 }
  );
}

async function sendNotification(
  fastify: FastifyInstance,
  tenantId: string,
  stepInstance: {
    id: string;
    workflowInstanceId: string;
    workflowInstance: { entityId: string };
  },
  config: ActionConfig
): Promise<void> {
  // Tenant-level switch: firm-wide mute for workflow notifications.
  if (!(await isTenantEventEnabled(fastify.prisma, tenantId, "workflow_events"))) return;

  await dispatchWorkflowEvent(fastify.prisma, tenantId, {
    userId: config.userId ?? null,
    category: "projects",
    subject: config.subject ?? "Notificare workflow",
    body: config.body ?? "Workflow notification",
    url: stepInstance.workflowInstance.entityId
      ? `/projects/${stepInstance.workflowInstance.entityId}`
      : "/dashboard",
    clientId: config.clientId ?? null,
    projectId: stepInstance.workflowInstance.entityId,
    workflowInstanceId: stepInstance.workflowInstanceId,
  });
}

async function updateProjectStatus(
  fastify: FastifyInstance,
  tenantId: string,
  stepInstance: {
    workflowInstance: { entityId: string };
  },
  config: ActionConfig
): Promise<void> {
  if (!config.status) {
    fastify.log.warn("update_project_status action missing 'status' in config");
    return;
  }

  await fastify.prisma.project.updateMany({
    where: {
      id: stepInstance.workflowInstance.entityId,
      tenantId,
    },
    data: {
      status: config.status,
    },
  });
}

/** Resolve {{placeholder}} values in a string using a context object */
function resolveTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
    const value = resolvePath(context, path.trim());
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

/** Recursively resolve {{placeholder}} values in an object/array/string */
function resolveTemplateDeep(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === "string") return resolveTemplate(value, context);
  if (Array.isArray(value)) return value.map((v) => resolveTemplateDeep(v, context));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = resolveTemplateDeep(v, context);
    }
    return result;
  }
  return value;
}

async function callApi(
  fastify: FastifyInstance,
  tenantId: string,
  stepInstance: {
    id: string;
    workflowInstanceId: string;
    workflowInstance: { entityId: string; contextJson?: unknown };
    outputJson?: unknown;
    itemContextJson?: unknown;
  },
  config: ActionConfig
): Promise<void> {
  if (!config.url) {
    fastify.log.warn("call_api action missing 'url' in config");
    return;
  }

  // Build context for placeholder resolution
  const context: Record<string, unknown> = {
    ...(typeof stepInstance.workflowInstance.contextJson === "object" &&
    stepInstance.workflowInstance.contextJson !== null
      ? (stepInstance.workflowInstance.contextJson as Record<string, unknown>)
      : {}),
    step_output:
      typeof stepInstance.outputJson === "object" && stepInstance.outputJson !== null
        ? stepInstance.outputJson
        : {},
    ...(typeof stepInstance.itemContextJson === "object" && stepInstance.itemContextJson !== null
      ? (stepInstance.itemContextJson as Record<string, unknown>)
      : {}),
  };

  const url = resolveTemplate(config.url, context);
  const method = (config.method ?? "POST").toUpperCase();

  // Resolve headers
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.headers) {
    for (const [k, v] of Object.entries(config.headers)) {
      headers[k] = resolveTemplate(v, context);
    }
  }

  // Resolve body template
  const body = config.bodyTemplate
    ? JSON.stringify(resolveTemplateDeep(config.bodyTemplate, context))
    : undefined;

  const fetchOptions: RequestInit = { method, headers };
  if (body && method !== "GET") {
    fetchOptions.body = body;
  }

  const startTime = Date.now();
  let responseStatus: number | null = null;
  let responseBody: unknown = null;
  let error: string | null = null;

  try {
    const response = await fetch(url, fetchOptions);
    responseStatus = response.status;
    const text = await response.text();
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = text;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - startTime;

  // Log the API call result
  await fastify.prisma.workflowExecutionLog.create({
    data: {
      tenantId,
      workflowInstanceId: stepInstance.workflowInstanceId,
      stepInstanceId: stepInstance.id,
      eventType: "action_call_api",
      payloadJson: {
        url,
        method,
        responseStatus,
        durationMs,
        ...(error ? { error } : {}),
      } as Prisma.InputJsonValue,
    },
  });

  if (error) {
    fastify.log.error({ url, method, error }, "call_api action failed");
  }
}
