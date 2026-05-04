import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { validateWorkflow } from "../../lib/workflow-validator.js";
import type {
  CreateWorkflowDefinitionInput,
  UpdateWorkflowDefinitionInput,
  CreateStepInput,
  UpdateStepInput,
  CreateTransitionInput,
  UpdateTransitionInput,
  CreateStepActionInput,
  UpdateStepActionInput,
  CloneWorkflowInput,
} from "./workflow-definitions.schema.js";

export async function list(
  fastify: FastifyInstance,
  tenantId: string | null,
  filters?: { status?: string; projectTypeId?: string; masterOnly?: boolean; category?: string }
) {
  let where: Prisma.WorkflowDefinitionWhereInput;

  // Unless explicitly requesting archived, hide them
  const statusFilter = filters?.status
    ? { status: filters.status }
    : { status: { not: "archived" as const } };

  if (filters?.masterOnly) {
    // Only master (global) workflows
    where = {
      tenantId: null,
      ...statusFilter,
      ...(filters?.category && { category: filters.category }),
    };
  } else if (tenantId) {
    // Tenant workflows + published master workflows
    where = {
      OR: [
        {
          tenantId,
          ...(filters?.projectTypeId && { projectTypeId: filters.projectTypeId }),
        },
        { tenantId: null, status: "published" },
      ],
      ...statusFilter,
      ...(filters?.category && { category: filters.category }),
    };
  } else {
    // Master admin context — show all master workflows
    where = {
      tenantId: null,
      ...statusFilter,
      ...(filters?.category && { category: filters.category }),
    };
  }

  return fastify.prisma.workflowDefinition.findMany({
    where,
    include: {
      _count: { select: { steps: true } },
      projectType: { select: { id: true, code: true, name: true } },
    },
    orderBy: [{ code: "asc" }, { version: "desc" }],
  });
}

export async function getById(
  fastify: FastifyInstance,
  tenantId: string | null,
  id: string
) {
  // Allow reading own tenant workflows OR master workflows (tenantId=null)
  const definition = await fastify.prisma.workflowDefinition.findFirst({
    where: {
      id,
      OR: tenantId
        ? [{ tenantId }, { tenantId: null }]
        : [{ tenantId: null }],
    },
    include: {
      projectType: { select: { id: true, code: true, name: true } },
      createdBy: {
        select: { id: true, firstName: true, lastName: true },
      },
      steps: {
        orderBy: { orderIndex: "asc" },
        include: {
          actions: { orderBy: { createdAt: "asc" } },
        },
      },
      transitions: {
        orderBy: { priority: "asc" },
        include: {
          fromStep: { select: { id: true, code: true, name: true } },
          toStep: { select: { id: true, code: true, name: true } },
        },
      },
    },
  });

  if (!definition) {
    throw fastify.httpErrors.notFound("Workflow definition not found");
  }

  return definition;
}

export async function create(
  fastify: FastifyInstance,
  tenantId: string,
  createdById: string,
  input: CreateWorkflowDefinitionInput
) {
  // Auto-generate code from name if not provided
  const code =
    input.code ||
    input.name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");

  // Check for duplicate code within this tenant
  const existing = await fastify.prisma.workflowDefinition.findFirst({
    where: { tenantId, code },
  });
  if (existing) {
    throw fastify.httpErrors.badRequest(
      `Workflow definition with code "${code}" already exists`
    );
  }

  if (input.projectTypeId) {
    const projectType = await fastify.prisma.projectType.findFirst({
      where: { id: input.projectTypeId, tenantId },
    });
    if (!projectType) {
      throw fastify.httpErrors.notFound("Project type not found");
    }
  }

  return fastify.prisma.workflowDefinition.create({
    data: {
      tenantId,
      code,
      name: input.name,
      entityType: input.entityType ?? "project",
      projectTypeId: input.projectTypeId ?? null,
      description: input.description ?? null,
      category: input.category ?? null,
      configJson: input.configJson as Prisma.InputJsonValue | undefined,
      version: 1,
      status: "draft",
      createdById,
    },
    include: {
      _count: { select: { steps: true } },
      projectType: { select: { id: true, code: true, name: true } },
    },
  });
}

export async function update(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
  input: UpdateWorkflowDefinitionInput
) {
  const definition = await fastify.prisma.workflowDefinition.findFirst({
    where: { id, tenantId },
  });
  if (!definition) {
    throw fastify.httpErrors.notFound("Workflow definition not found");
  }
  if (definition.status === "archived") {
    throw fastify.httpErrors.badRequest(
      "Archived workflow definitions cannot be updated"
    );
  }

  return fastify.prisma.workflowDefinition.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.category !== undefined && { category: input.category }),
      ...(input.configJson !== undefined && {
        configJson: input.configJson as Prisma.InputJsonValue,
      }),
    },
    include: {
      _count: { select: { steps: true } },
      projectType: { select: { id: true, code: true, name: true } },
    },
  });
}

async function ensureDefinitionIsEditable(
  fastify: FastifyInstance,
  tenantId: string | null,
  definitionId: string
) {
  const definition = await fastify.prisma.workflowDefinition.findFirst({
    where: { id: definitionId, tenantId },
  });
  if (!definition) {
    throw fastify.httpErrors.notFound("Workflow definition not found");
  }
  if (definition.status === "archived") {
    throw fastify.httpErrors.badRequest(
      "Archived workflow definitions cannot be modified"
    );
  }
  return definition;
}

/**
 * Create a master (global) workflow definition — tenantId=null.
 * Only accessible by MASTER_ADMIN users.
 */
export async function createMaster(
  fastify: FastifyInstance,
  createdById: string,
  input: CreateWorkflowDefinitionInput
) {
  const code =
    input.code ||
    input.name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");

  const existing = await fastify.prisma.workflowDefinition.findFirst({
    where: { tenantId: null, code },
  });
  if (existing) {
    throw fastify.httpErrors.badRequest(
      `Master workflow definition with code "${code}" already exists`
    );
  }

  return fastify.prisma.workflowDefinition.create({
    data: {
      tenantId: null,
      code,
      name: input.name,
      entityType: input.entityType ?? "project",
      projectTypeId: input.projectTypeId ?? null,
      description: input.description ?? null,
      configJson: input.configJson as Prisma.InputJsonValue | undefined,
      version: 1,
      status: "draft",
      createdById,
    },
    include: {
      _count: { select: { steps: true } },
      projectType: { select: { id: true, code: true, name: true } },
    },
  });
}

/**
 * Update a master workflow definition.
 */
export async function updateMaster(
  fastify: FastifyInstance,
  id: string,
  input: UpdateWorkflowDefinitionInput
) {
  const definition = await fastify.prisma.workflowDefinition.findFirst({
    where: { id, tenantId: null },
  });
  if (!definition) {
    throw fastify.httpErrors.notFound("Master workflow definition not found");
  }
  if (definition.status === "archived") {
    throw fastify.httpErrors.badRequest(
      "Archived workflow definitions cannot be updated"
    );
  }

  return fastify.prisma.workflowDefinition.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.configJson !== undefined && {
        configJson: input.configJson as Prisma.InputJsonValue,
      }),
    },
    include: {
      _count: { select: { steps: true } },
      projectType: { select: { id: true, code: true, name: true } },
    },
  });
}

export async function addStep(
  fastify: FastifyInstance,
  tenantId: string | null,
  definitionId: string,
  input: CreateStepInput
) {
  await ensureDefinitionIsEditable(fastify, tenantId, definitionId);

  // Auto-calculate orderIndex if not provided (default 0)
  let orderIndex = input.orderIndex;
  if (orderIndex === 0) {
    const maxStep = await fastify.prisma.workflowStep.findFirst({
      where: { workflowDefinitionId: definitionId },
      orderBy: { orderIndex: "desc" },
      select: { orderIndex: true },
    });
    orderIndex = (maxStep?.orderIndex ?? -1) + 1;
  }

  return fastify.prisma.workflowStep.create({
    data: {
      tenantId,
      workflowDefinitionId: definitionId,
      code: input.code,
      name: input.name,
      stepType: input.stepType,
      orderIndex,
      isStart: input.isStart ?? false,
      isTerminal: input.isTerminal ?? false,
      configJson: input.configJson as Prisma.InputJsonValue | undefined,
      formSchemaJson: input.formSchemaJson as Prisma.InputJsonValue | undefined,
      validationSchemaJson: input.validationSchemaJson as Prisma.InputJsonValue | undefined,
      uiSchemaJson: input.uiSchemaJson as Prisma.InputJsonValue | undefined,
    },
    include: {
      actions: true,
    },
  });
}

export async function updateStep(
  fastify: FastifyInstance,
  tenantId: string | null,
  stepId: string,
  input: UpdateStepInput
) {
  const step = await fastify.prisma.workflowStep.findFirst({
    where: { id: stepId, tenantId },
  });
  if (!step) {
    throw fastify.httpErrors.notFound("Workflow step not found");
  }

  await ensureDefinitionIsEditable(fastify, tenantId, step.workflowDefinitionId);

  return fastify.prisma.workflowStep.update({
    where: { id: stepId },
    data: {
      ...(input.code !== undefined && { code: input.code }),
      ...(input.name !== undefined && { name: input.name }),
      ...(input.stepType !== undefined && { stepType: input.stepType }),
      ...(input.orderIndex !== undefined && { orderIndex: input.orderIndex }),
      ...(input.isStart !== undefined && { isStart: input.isStart }),
      ...(input.isTerminal !== undefined && { isTerminal: input.isTerminal }),
      ...(input.joinMode !== undefined && { joinMode: input.joinMode }),
      ...(input.nameTemplate !== undefined && { nameTemplate: input.nameTemplate }),
      ...(input.configJson !== undefined && {
        configJson: input.configJson as Prisma.InputJsonValue,
      }),
      ...(input.formSchemaJson !== undefined && {
        formSchemaJson: input.formSchemaJson as Prisma.InputJsonValue,
      }),
      ...(input.validationSchemaJson !== undefined && {
        validationSchemaJson: input.validationSchemaJson as Prisma.InputJsonValue,
      }),
      ...(input.uiSchemaJson !== undefined && {
        uiSchemaJson: input.uiSchemaJson as Prisma.InputJsonValue,
      }),
    },
    include: {
      actions: true,
    },
  });
}

export async function removeStep(
  fastify: FastifyInstance,
  tenantId: string | null,
  stepId: string
) {
  const step = await fastify.prisma.workflowStep.findFirst({
    where: { id: stepId, tenantId },
  });
  if (!step) {
    throw fastify.httpErrors.notFound("Workflow step not found");
  }

  await ensureDefinitionIsEditable(fastify, tenantId, step.workflowDefinitionId);

  // Block deletion if any active workflow instances reference this step
  const activeInstances = await fastify.prisma.workflowStepInstance.count({
    where: {
      stepDefinitionId: stepId,
      status: { in: ["active", "waiting", "pending"] },
    },
  });
  if (activeInstances > 0) {
    throw fastify.httpErrors.conflict(
      "Cannot delete step: it is referenced by active workflow instances"
    );
  }

  // Cascade: delete completed/cancelled instances, actions, transitions, then the step
  await fastify.prisma.$transaction([
    fastify.prisma.workflowStepInstance.deleteMany({
      where: { stepDefinitionId: stepId },
    }),
    fastify.prisma.workflowStepAction.deleteMany({
      where: { stepId },
    }),
    fastify.prisma.workflowTransition.deleteMany({
      where: {
        workflowDefinitionId: step.workflowDefinitionId,
        OR: [{ fromStepId: stepId }, { toStepId: stepId }],
      },
    }),
    fastify.prisma.workflowStep.delete({ where: { id: stepId } }),
  ]);

  return { success: true };
}

export async function addTransition(
  fastify: FastifyInstance,
  tenantId: string | null,
  definitionId: string,
  input: CreateTransitionInput
) {
  await ensureDefinitionIsEditable(fastify, tenantId, definitionId);

  // Verify both steps belong to this definition
  const fromStep = await fastify.prisma.workflowStep.findFirst({
    where: { id: input.fromStepId, workflowDefinitionId: definitionId },
  });
  if (!fromStep) {
    throw fastify.httpErrors.badRequest(
      "fromStepId does not belong to this workflow definition"
    );
  }

  const toStep = await fastify.prisma.workflowStep.findFirst({
    where: { id: input.toStepId, workflowDefinitionId: definitionId },
  });
  if (!toStep) {
    throw fastify.httpErrors.badRequest(
      "toStepId does not belong to this workflow definition"
    );
  }

  return fastify.prisma.workflowTransition.create({
    data: {
      tenantId,
      workflowDefinitionId: definitionId,
      fromStepId: input.fromStepId,
      toStepId: input.toStepId,
      transitionType: input.transitionType,
      label: input.label ?? null,
      priority: input.priority ?? 0,
      conditionJson: input.conditionJson as Prisma.InputJsonValue | undefined,
      configJson: input.configJson as Prisma.InputJsonValue | undefined,
      spawnMode: input.spawnMode ?? "single",
      foreachPath: input.foreachPath ?? null,
      itemContextKey: input.itemContextKey ?? null,
    },
  });
}

export async function updateTransition(
  fastify: FastifyInstance,
  tenantId: string | null,
  transitionId: string,
  input: UpdateTransitionInput
) {
  const transition = await fastify.prisma.workflowTransition.findFirst({
    where: { id: transitionId, tenantId },
  });
  if (!transition) {
    throw fastify.httpErrors.notFound("Workflow transition not found");
  }

  await ensureDefinitionIsEditable(
    fastify,
    tenantId,
    transition.workflowDefinitionId
  );

  return fastify.prisma.workflowTransition.update({
    where: { id: transitionId },
    data: {
      ...(input.transitionType !== undefined && {
        transitionType: input.transitionType,
      }),
      ...(input.label !== undefined && { label: input.label }),
      ...(input.priority !== undefined && { priority: input.priority }),
      ...(input.conditionJson !== undefined && {
        conditionJson: input.conditionJson as Prisma.InputJsonValue,
      }),
      ...(input.spawnMode !== undefined && { spawnMode: input.spawnMode }),
      ...(input.foreachPath !== undefined && { foreachPath: input.foreachPath }),
      ...(input.itemContextKey !== undefined && { itemContextKey: input.itemContextKey }),
    },
  });
}

export async function removeTransition(
  fastify: FastifyInstance,
  tenantId: string | null,
  transitionId: string
) {
  const transition = await fastify.prisma.workflowTransition.findFirst({
    where: { id: transitionId, tenantId },
  });
  if (!transition) {
    throw fastify.httpErrors.notFound("Workflow transition not found");
  }

  await ensureDefinitionIsEditable(
    fastify,
    tenantId,
    transition.workflowDefinitionId
  );

  await fastify.prisma.workflowTransition.delete({
    where: { id: transitionId },
  });

  return { success: true };
}

export async function addStepAction(
  fastify: FastifyInstance,
  tenantId: string | null,
  input: CreateStepActionInput
) {
  const step = await fastify.prisma.workflowStep.findFirst({
    where: { id: input.stepId, tenantId },
  });
  if (!step) {
    throw fastify.httpErrors.notFound("Workflow step not found");
  }

  await ensureDefinitionIsEditable(fastify, tenantId, step.workflowDefinitionId);

  return fastify.prisma.workflowStepAction.create({
    data: {
      tenantId,
      stepId: input.stepId,
      triggerEvent: input.triggerEvent,
      actionType: input.actionType,
      targetFieldKey: input.targetFieldKey ?? null,
      actionConfigJson: input.actionConfigJson as
        | Prisma.InputJsonValue
        | undefined,
    },
  });
}

export async function updateStepAction(
  fastify: FastifyInstance,
  tenantId: string | null,
  actionId: string,
  input: UpdateStepActionInput
) {
  const action = await fastify.prisma.workflowStepAction.findFirst({
    where: { id: actionId, tenantId },
  });
  if (!action) {
    throw fastify.httpErrors.notFound("Workflow step action not found");
  }

  const step = await fastify.prisma.workflowStep.findFirst({
    where: { id: action.stepId, tenantId },
  });
  if (!step) {
    throw fastify.httpErrors.notFound("Workflow step not found");
  }

  await ensureDefinitionIsEditable(fastify, tenantId, step.workflowDefinitionId);

  return fastify.prisma.workflowStepAction.update({
    where: { id: actionId },
    data: {
      ...(input.triggerEvent !== undefined && { triggerEvent: input.triggerEvent }),
      ...(input.actionType !== undefined && { actionType: input.actionType }),
      ...(input.targetFieldKey !== undefined && { targetFieldKey: input.targetFieldKey }),
      ...(input.actionConfigJson !== undefined && {
        actionConfigJson: input.actionConfigJson as Prisma.InputJsonValue,
      }),
    },
  });
}

export async function removeStepAction(
  fastify: FastifyInstance,
  tenantId: string | null,
  actionId: string
) {
  const action = await fastify.prisma.workflowStepAction.findFirst({
    where: { id: actionId, tenantId },
  });
  if (!action) {
    throw fastify.httpErrors.notFound("Workflow step action not found");
  }

  const step = await fastify.prisma.workflowStep.findFirst({
    where: { id: action.stepId, tenantId },
  });
  if (!step) {
    throw fastify.httpErrors.notFound("Workflow step not found");
  }

  await ensureDefinitionIsEditable(fastify, tenantId, step.workflowDefinitionId);

  await fastify.prisma.workflowStepAction.delete({
    where: { id: actionId },
  });

  return { success: true };
}

export async function validate(
  fastify: FastifyInstance,
  tenantId: string | null,
  id: string
) {
  const definition = await fastify.prisma.workflowDefinition.findFirst({
    where: {
      id,
      OR: tenantId
        ? [{ tenantId }, { tenantId: null }]
        : [{ tenantId: null }],
    },
    include: {
      steps: true,
      transitions: true,
    },
  });

  if (!definition) {
    throw fastify.httpErrors.notFound("Workflow definition not found");
  }

  const result = validateWorkflow({
    steps: definition.steps.map((s) => ({
      id: s.id,
      code: s.code,
      stepType: s.stepType,
      isStart: s.isStart,
      isTerminal: s.isTerminal,
      configJson: s.configJson,
    })),
    transitions: definition.transitions.map((t) => ({
      id: t.id,
      fromStepId: t.fromStepId,
      toStepId: t.toStepId,
      transitionType: t.transitionType,
    })),
  });

  return result;
}

export async function publish(
  fastify: FastifyInstance,
  tenantId: string | null,
  id: string
) {
  const definition = await fastify.prisma.workflowDefinition.findFirst({
    where: { id, tenantId },
  });
  if (!definition) {
    throw fastify.httpErrors.notFound("Workflow definition not found");
  }
  if (definition.status === "archived") {
    throw fastify.httpErrors.badRequest(
      "Archived workflow definitions cannot be published"
    );
  }

  const validationResult = await validate(fastify, tenantId, id);
  if (!validationResult.valid) {
    return { published: false, errors: validationResult.errors };
  }

  const updated = await fastify.prisma.workflowDefinition.update({
    where: { id },
    data: {
      status: "published",
      publishedAt: new Date(),
    },
    include: {
      _count: { select: { steps: true } },
      projectType: { select: { id: true, code: true, name: true } },
    },
  });

  return { published: true, definition: updated, errors: [] };
}

export async function clone(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
  createdById: string,
  input?: CloneWorkflowInput
) {
  // Allow cloning from own tenant OR from master workflows (tenantId=null)
  const source = await fastify.prisma.workflowDefinition.findFirst({
    where: {
      id,
      OR: [{ tenantId }, { tenantId: null }],
    },
    include: {
      steps: {
        include: { actions: true },
      },
      transitions: true,
    },
  });

  if (!source) {
    throw fastify.httpErrors.notFound("Workflow definition not found");
  }

  const targetCode = input?.code ?? source.code;

  // Determine next version for the target code
  const maxVersion = await fastify.prisma.workflowDefinition.findFirst({
    where: { tenantId, code: targetCode },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const nextVersion = (maxVersion?.version ?? 0) + 1;

  return fastify.prisma.$transaction(async (tx) => {
    // Create the new definition
    const newDefinition = await tx.workflowDefinition.create({
      data: {
        tenantId,
        code: targetCode,
        name: input?.name ?? source.name,
        entityType: source.entityType,
        projectTypeId: source.projectTypeId,
        description: source.description,
        configJson: source.configJson ?? undefined,
        version: nextVersion,
        status: "draft",
        createdById,
        baseDefinitionId: source.id,
      },
    });

    // Build a map from old step IDs to new step IDs
    const stepIdMap = new Map<string, string>();

    for (const step of source.steps) {
      const newStep = await tx.workflowStep.create({
        data: {
          tenantId,
          workflowDefinitionId: newDefinition.id,
          code: step.code,
          name: step.name,
          stepType: step.stepType,
          orderIndex: step.orderIndex,
          isStart: step.isStart,
          isTerminal: step.isTerminal,
          joinMode: step.joinMode,
          nameTemplate: step.nameTemplate,
          configJson: step.configJson ?? undefined,
          formSchemaJson: step.formSchemaJson ?? undefined,
          validationSchemaJson: step.validationSchemaJson ?? undefined,
          uiSchemaJson: step.uiSchemaJson ?? undefined,
        },
      });
      stepIdMap.set(step.id, newStep.id);

      // Clone step actions
      for (const action of step.actions) {
        await tx.workflowStepAction.create({
          data: {
            tenantId,
            stepId: newStep.id,
            triggerEvent: action.triggerEvent,
            actionType: action.actionType,
            targetFieldKey: action.targetFieldKey,
            actionConfigJson: action.actionConfigJson ?? undefined,
          },
        });
      }
    }

    // Clone transitions with remapped step IDs
    for (const transition of source.transitions) {
      const newFromStepId = stepIdMap.get(transition.fromStepId);
      const newToStepId = stepIdMap.get(transition.toStepId);

      if (newFromStepId && newToStepId) {
        await tx.workflowTransition.create({
          data: {
            tenantId,
            workflowDefinitionId: newDefinition.id,
            fromStepId: newFromStepId,
            toStepId: newToStepId,
            transitionType: transition.transitionType,
            label: transition.label,
            priority: transition.priority,
            conditionJson: transition.conditionJson ?? undefined,
            configJson: transition.configJson ?? undefined,
            spawnMode: transition.spawnMode,
            foreachPath: transition.foreachPath,
            itemContextKey: transition.itemContextKey,
          },
        });
      }
    }

    // Return the full new definition
    return tx.workflowDefinition.findFirst({
      where: { id: newDefinition.id },
      include: {
        _count: { select: { steps: true } },
        projectType: { select: { id: true, code: true, name: true } },
        steps: {
          orderBy: { orderIndex: "asc" },
          include: { actions: true },
        },
        transitions: {
          orderBy: { priority: "asc" },
        },
      },
    });
  });
}

export async function getVersions(
  fastify: FastifyInstance,
  tenantId: string,
  code: string
) {
  return fastify.prisma.workflowDefinition.findMany({
    where: { tenantId, code },
    include: {
      _count: { select: { steps: true } },
      createdBy: {
        select: { id: true, firstName: true, lastName: true },
      },
    },
    orderBy: { version: "desc" },
  });
}

export async function archive(
  fastify: FastifyInstance,
  tenantId: string | null,
  id: string
) {
  const definition = await fastify.prisma.workflowDefinition.findFirst({
    where: { id, tenantId },
  });
  if (!definition) {
    throw fastify.httpErrors.notFound("Workflow definition not found");
  }

  // Check for running instances
  const runningInstances = await fastify.prisma.workflowInstance.count({
    where: {
      workflowDefinitionId: id,
      ...(tenantId ? { tenantId } : {}),
      status: "running",
    },
  });

  if (runningInstances > 0) {
    throw fastify.httpErrors.badRequest(
      `Cannot archive workflow definition with ${runningInstances} running instance(s)`
    );
  }

  return fastify.prisma.workflowDefinition.update({
    where: { id },
    data: { status: "archived" },
    include: {
      _count: { select: { steps: true } },
      projectType: { select: { id: true, code: true, name: true } },
    },
  });
}
