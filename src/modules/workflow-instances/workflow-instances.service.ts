import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import type { StartWorkflowInput, ExecuteEventInput } from "./workflow-instances.schema.js";
import {
  completeStep as engineCompleteStep,
  failStep as engineFailStep,
  retryStep as engineRetryStep,
} from "../../lib/workflow-engine/index.js";
import { env } from "../../config/env.js";
import * as documentParseService from "../documents/documents-parse.service.js";

interface FileContext {
  fileBuffer?: Buffer;
  fileFilename?: string;
  fileMimetype?: string;
  authHeader?: string;
}

/**
 * Registry of internal API endpoints that accept file uploads.
 * Calls the corresponding service function directly, bypassing HTTP.
 */
async function callInternalFileEndpoint(
  fastify: FastifyInstance,
  method: string,
  path: string,
  fileCtx: Required<Pick<FileContext, "fileBuffer" | "fileFilename">> & Pick<FileContext, "fileMimetype">
): Promise<unknown> {
  const key = `${method}:${path}`;

  if (key === "POST:/api/documents/parse-permits") {
    const fakeFile = {
      filename: fileCtx.fileFilename,
      mimetype: fileCtx.fileMimetype ?? "application/octet-stream",
      toBuffer: async () => fileCtx.fileBuffer,
    };
    return documentParseService.parsePermits(fastify, fakeFile as any);
  }

  throw new Error(`No internal file handler registered for ${method} ${path}`);
}

/**
 * Start a workflow instance.
 *
 * 1. Verify definition is published
 * 2. Create WorkflowInstance with status "active"
 * 3. Find start step in definition
 * 4. Create first WorkflowStepInstance with status "active"
 * 5. Log "workflow_started" event
 */
export async function startWorkflow(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string,
  input: StartWorkflowInput
) {
  // Verify definition exists and is published
  const definition = await fastify.prisma.workflowDefinition.findFirst({
    where: {
      id: input.workflowDefinitionId,
      tenantId,
    },
    include: {
      steps: { orderBy: { orderIndex: "asc" } },
    },
  });

  if (!definition) {
    throw fastify.httpErrors.notFound("Workflow definition not found");
  }

  if (definition.status !== "published") {
    throw fastify.httpErrors.badRequest(
      "Workflow definition must be published before starting an instance"
    );
  }

  // Find the start step
  const startStep = definition.steps.find((s) => s.isStart);
  if (!startStep) {
    throw fastify.httpErrors.badRequest(
      "Workflow definition has no start step"
    );
  }

  const now = new Date();

  // Create workflow instance and first step instance in a transaction
  const instance = await fastify.prisma.$transaction(async (tx) => {
    // Create WorkflowInstance
    const workflowInstance = await tx.workflowInstance.create({
      data: {
        tenantId,
        workflowDefinitionId: input.workflowDefinitionId,
        entityType: input.entityType,
        entityId: input.entityId,
        status: "active",
        currentStepCode: startStep.code,
        startedAt: now,
      },
    });

    // Create first WorkflowStepInstance
    await tx.workflowStepInstance.create({
      data: {
        tenantId,
        workflowInstanceId: workflowInstance.id,
        stepDefinitionId: startStep.id,
        status: "active",
        startedAt: now,
      },
    });

    // Log workflow_started event
    await tx.workflowExecutionLog.create({
      data: {
        tenantId,
        workflowInstanceId: workflowInstance.id,
        eventType: "workflow_started",
        payloadJson: {
          definitionCode: definition.code,
          definitionName: definition.name,
          entityType: input.entityType,
          entityId: input.entityId,
          startStepCode: startStep.code,
          userId,
        } as Prisma.InputJsonValue,
      },
    });

    return workflowInstance;
  });

  return instance;
}

/**
 * Get the workflow instance for a project (entityType="project", entityId=projectId).
 * Includes stepInstances (with stepDefinition) and workflowDefinition (with steps and transitions).
 */
export async function getByProject(
  fastify: FastifyInstance,
  tenantId: string,
  projectId: string
) {
  // 1. Find the root workflow instance (lightweight query)
  const instance = await fastify.prisma.workflowInstance.findFirst({
    where: {
      tenantId,
      entityType: "project",
      entityId: projectId,
      parentWorkflowInstanceId: null, // Only root workflows, not sub-workflows
    },
    include: {
      workflowDefinition: {
        include: {
          steps: { orderBy: { orderIndex: "asc" } },
          transitions: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!instance) {
    throw fastify.httpErrors.notFound(
      "No workflow instance found for this project"
    );
  }

  // 2. Load step instances (flat query, no deep JOINs)
  const stepInstances = await fastify.prisma.workflowStepInstance.findMany({
    where: { workflowInstanceId: instance.id, tenantId },
    include: {
      stepDefinition: {
        include: { actions: { orderBy: { createdAt: "asc" } } },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  // 3. Load child workflows separately (only if there are sub_workflow steps)
  const subWorkflowStepIds = stepInstances
    .filter((si) => si.stepDefinition.stepType === "sub_workflow")
    .map((si) => si.id);

  const childWorkflows = subWorkflowStepIds.length > 0
    ? await fastify.prisma.workflowInstance.findMany({
        where: {
          tenantId,
          parentStepInstanceId: { in: subWorkflowStepIds },
        },
        select: {
          id: true,
          status: true,
          parentStepInstanceId: true,
          workflowDefinition: {
            include: {
              steps: { orderBy: { orderIndex: "asc" } },
              transitions: true,
            },
          },
          stepInstances: {
            include: {
              stepDefinition: {
                include: { actions: { orderBy: { createdAt: "asc" } } },
              },
            },
            orderBy: { createdAt: "asc" },
          },
        },
      })
    : [];

  // 4. Index child workflows by parent step instance ID
  const childByParentStep = new Map<string, (typeof childWorkflows)[number]>();
  for (const cw of childWorkflows) {
    if (cw.parentStepInstanceId) {
      childByParentStep.set(cw.parentStepInstanceId, cw);
    }
  }

  // 5. Assemble the result matching the original nested shape
  const assembledStepInstances = stepInstances.map((si) => ({
    ...si,
    childWorkflowInstance: childByParentStep.get(si.id) ?? null,
  }));

  return {
    ...instance,
    stepInstances: assembledStepInstances,
  };
}

/**
 * Get a workflow instance by ID.
 * Includes stepInstances with stepDefinition and workflowDefinition.
 */
export async function getById(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const instance = await fastify.prisma.workflowInstance.findFirst({
    where: { id, tenantId },
    include: {
      stepInstances: {
        include: { stepDefinition: true },
        orderBy: { createdAt: "asc" },
      },
      workflowDefinition: true,
    },
  });

  if (!instance) {
    throw fastify.httpErrors.notFound("Workflow instance not found");
  }

  return instance;
}

/**
 * Get WorkflowExecutionLog entries for an instance, ordered by createdAt desc.
 */
export async function getLogs(
  fastify: FastifyInstance,
  tenantId: string,
  instanceId: string
) {
  // Verify instance exists and belongs to tenant
  const instance = await fastify.prisma.workflowInstance.findFirst({
    where: { id: instanceId, tenantId },
    select: { id: true },
  });

  if (!instance) {
    throw fastify.httpErrors.notFound("Workflow instance not found");
  }

  return fastify.prisma.workflowExecutionLog.findMany({
    where: {
      tenantId,
      workflowInstanceId: instanceId,
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Complete a step instance using the workflow engine.
 */
export async function completeStep(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string,
  stepInstanceId: string,
  output?: unknown
) {
  return engineCompleteStep(fastify, tenantId, stepInstanceId, userId, output);
}

/**
 * Fail a step instance using the workflow engine.
 */
export async function failStep(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string,
  stepInstanceId: string,
  error?: string
) {
  return engineFailStep(fastify, tenantId, stepInstanceId, userId, error);
}

/**
 * Retry a failed step instance using the workflow engine.
 */
export async function retryStep(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string,
  stepInstanceId: string
) {
  return engineRetryStep(fastify, tenantId, stepInstanceId, userId);
}

/**
 * Cancel a workflow instance.
 * Sets status to "cancelled", cancels all active/pending step instances, logs "workflow_cancelled".
 */
export async function cancel(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string,
  instanceId: string
) {
  const instance = await fastify.prisma.workflowInstance.findFirst({
    where: { id: instanceId, tenantId },
  });

  if (!instance) {
    throw fastify.httpErrors.notFound("Workflow instance not found");
  }

  if (instance.status === "completed" || instance.status === "cancelled") {
    throw fastify.httpErrors.badRequest(
      `Workflow instance cannot be cancelled in status "${instance.status}"`
    );
  }

  const now = new Date();

  return fastify.prisma.$transaction(async (tx) => {
    // Cancel the workflow instance
    const updated = await tx.workflowInstance.update({
      where: { id: instanceId },
      data: {
        status: "cancelled",
        completedAt: now,
      },
    });

    // Cancel all active/pending step instances
    await tx.workflowStepInstance.updateMany({
      where: {
        workflowInstanceId: instanceId,
        tenantId,
        status: { in: ["active", "pending", "waiting"] },
      },
      data: {
        status: "cancelled",
        completedAt: now,
      },
    });

    // Log workflow_cancelled event
    await tx.workflowExecutionLog.create({
      data: {
        tenantId,
        workflowInstanceId: instanceId,
        eventType: "workflow_cancelled",
        payloadJson: {
          userId,
          cancelledAt: now.toISOString(),
        } as Prisma.InputJsonValue,
      },
    });

    return updated;
  });
}

/**
 * Execute a frontend event listener action as a proxy.
 * The browser cannot call external APIs directly, so the backend proxies the call
 * and returns field updates to the frontend.
 */
export async function executeEvent(
  fastify: FastifyInstance,
  tenantId: string,
  stepInstanceId: string,
  input: ExecuteEventInput,
  fileCtx: FileContext = {}
) {
  // 1. Load the step instance and verify it's active
  const stepInstance = await fastify.prisma.workflowStepInstance.findFirst({
    where: { id: stepInstanceId, tenantId, status: "active" },
    include: {
      stepDefinition: {
        include: { actions: true },
      },
      workflowInstance: true,
    },
  });

  if (!stepInstance) {
    throw fastify.httpErrors.notFound(
      "Active step instance not found"
    );
  }

  // 2. Find the action and verify it belongs to this step's definition
  const action = stepInstance.stepDefinition.actions.find(
    (a) => a.id === input.actionId
  );

  if (!action) {
    throw fastify.httpErrors.badRequest(
      "Action not found for this step definition"
    );
  }

  const config = (action.actionConfigJson ?? {}) as {
    apiType?: "internal" | "external";
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    bodyTemplate?: unknown;
    responseMapping?: Array<{
      sourcePath: string;
      targetFieldKey: string;
      mappingType?: string;
      itemMapping?: Array<{ sourceProp: string; targetProp: string }>;
    }>;
  };

  if (!config.url) {
    throw fastify.httpErrors.badRequest("Action has no URL configured");
  }

  // 3. Build context for placeholder resolution
  const context: Record<string, unknown> = {
    ...(typeof stepInstance.workflowInstance.contextJson === "object" &&
    stepInstance.workflowInstance.contextJson !== null
      ? (stepInstance.workflowInstance.contextJson as Record<string, unknown>)
      : {}),
    ...(typeof stepInstance.itemContextJson === "object" && stepInstance.itemContextJson !== null
      ? (stepInstance.itemContextJson as Record<string, unknown>)
      : {}),
    trigger: input.triggerPayload,
    form: input.triggerPayload.formValues ?? {},
  };

  // Resolve URL — internal paths get the local base URL prepended
  const isInternal = config.apiType === "internal";
  const resolvedPath = resolveTemplate(config.url, context);
  const url = isInternal
    ? `http://127.0.0.1:${env.PORT}${resolvedPath}`
    : resolvedPath;

  const method = (config.method ?? "POST").toUpperCase();

  // 4. Execute the action call — internal file endpoints are called directly (no HTTP proxy)
  let responseBody: unknown;

  if (isInternal && fileCtx.fileBuffer && fileCtx.fileFilename) {
    // Direct service call: avoids HTTP-layer issues (content negotiation, multipart parsing)
    // when making loopback requests from within the same Node.js process.
    try {
      responseBody = await callInternalFileEndpoint(fastify, method, resolvedPath, {
        fileBuffer: fileCtx.fileBuffer,
        fileFilename: fileCtx.fileFilename,
        fileMimetype: fileCtx.fileMimetype,
      });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode) throw err;
      throw fastify.httpErrors.badGateway(
        `Internal service call failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    // HTTP call (external APIs or internal non-file endpoints)
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (isInternal && fileCtx.authHeader) {
      headers["Authorization"] = fileCtx.authHeader;
    }
    if (config.headers) {
      for (const [k, v] of Object.entries(config.headers)) {
        headers[k] = resolveTemplate(v, context);
      }
    }

    const body = config.bodyTemplate
      ? JSON.stringify(resolveTemplateDeep(config.bodyTemplate, context))
      : undefined;

    const fetchOptions: RequestInit = { method, headers };
    if (body && method !== "GET") {
      fetchOptions.body = body;
    }

    try {
      const response = await fetch(url, fetchOptions);
      const text = await response.text();
      try {
        responseBody = JSON.parse(text);
      } catch {
        responseBody = text;
      }

      if (!response.ok) {
        throw fastify.httpErrors.badGateway(
          `External API returned ${response.status}`
        );
      }
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode) throw err;
      throw fastify.httpErrors.badGateway(
        `Failed to call external API: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // 5. Map response to field updates
  const fieldUpdates: Array<{ targetFieldKey: string; value: unknown; mappingType: string }> = [];

  const hasMapping = Array.isArray(config.responseMapping) && config.responseMapping.length > 0;

  if (hasMapping && typeof responseBody === "object" && responseBody !== null) {
    for (const mapping of config.responseMapping!) {
      if (mapping.mappingType === "array_map") {
        // Array expansion: skip silently if no itemMapping configured
        if (!Array.isArray(mapping.itemMapping) || mapping.itemMapping.length === 0) {
          fastify.log.warn(
            { targetFieldKey: mapping.targetFieldKey },
            "array_map response mapping has no itemMapping configured — skipping"
          );
          continue;
        }
        const sourceArray = resolvePath(responseBody as Record<string, unknown>, mapping.sourcePath);
        if (Array.isArray(sourceArray)) {
          const rows = sourceArray.map((item: unknown) => {
            const row: Record<string, unknown> = {};
            for (const im of mapping.itemMapping!) {
              row[im.targetProp] = typeof item === "object" && item !== null
                ? resolvePath(item as Record<string, unknown>, im.sourceProp)
                : undefined;
            }
            return row;
          });
          fieldUpdates.push({ targetFieldKey: mapping.targetFieldKey, value: rows, mappingType: "replace" });
        } else {
          fastify.log.warn(
            { sourcePath: mapping.sourcePath },
            "array_map: sourcePath did not resolve to an array in the response"
          );
        }
      } else {
        const value = resolvePath(responseBody as Record<string, unknown>, mapping.sourcePath);
        if (value !== undefined) {
          fieldUpdates.push({
            targetFieldKey: mapping.targetFieldKey,
            value,
            mappingType: mapping.mappingType ?? "replace",
          });
        }
      }
    }
  } else if (!hasMapping && responseBody !== undefined && responseBody !== null) {
    // No responseMapping configured — return the full API response under "_response".
    // We intentionally avoid using action.targetFieldKey here because that key
    // identifies the trigger field (e.g. the file upload field), not an output target.
    fieldUpdates.push({
      targetFieldKey: "_response",
      value: responseBody,
      mappingType: "replace",
    });
  }

  // 6. Log the event execution
  await fastify.prisma.workflowExecutionLog.create({
    data: {
      tenantId,
      workflowInstanceId: stepInstance.workflowInstanceId,
      stepInstanceId: stepInstance.id,
      eventType: "frontend_event_executed",
      payloadJson: {
        actionId: input.actionId,
        triggerEvent: action.triggerEvent,
        url,
        method,
        fieldUpdatesCount: fieldUpdates.length,
        responseBody: responseBody ?? null,
      } as Prisma.InputJsonValue,
    },
  });

  return { success: true, fieldUpdates, responseBody };
}

/** Resolve {{placeholder}} values in a string */
function resolveTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
    const value = resolvePath(context, path.trim());
    return value !== undefined && value !== null ? String(value) : "";
  });
}

/** Resolve a dot-separated path on an object */
function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((cur, key) => {
    if (cur && typeof cur === "object" && key in (cur as Record<string, unknown>)) {
      return (cur as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/** Recursively resolve {{placeholder}} values */
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

