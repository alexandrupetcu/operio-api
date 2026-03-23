import type { FastifyInstance } from "fastify";
import type {
  InitializePlanInput,
  UpdateTaskInput,
  CreateTaskInput,
  ReorderTasksInput,
} from "./action-plans.schema.js";

const taskInclude = {
  dependsOnTask: {
    select: { id: true, name: true, status: true },
  },
} as const;

const planInclude = {
  template: { select: { id: true, name: true, projectType: true } },
  tasks: {
    include: taskInclude,
    orderBy: { sortOrder: "asc" as const },
  },
} as const;

export async function getByProjectId(
  fastify: FastifyInstance,
  tenantId: string,
  projectId: string
) {
  // Verify project belongs to tenant
  const project = await fastify.prisma.project.findFirst({
    where: { id: projectId, tenantId },
  });
  if (!project) throw fastify.httpErrors.notFound("Project not found");

  const plan = await fastify.prisma.actionPlan.findUnique({
    where: { projectId },
    include: planInclude,
  });

  return plan; // null if not initialized
}

export async function initializeFromTemplate(
  fastify: FastifyInstance,
  tenantId: string,
  projectId: string,
  input: InitializePlanInput
) {
  // Verify project
  const project = await fastify.prisma.project.findFirst({
    where: { id: projectId, tenantId },
  });
  if (!project) throw fastify.httpErrors.notFound("Project not found");

  // Check if already initialized
  const existing = await fastify.prisma.actionPlan.findUnique({
    where: { projectId },
  });
  if (existing)
    throw fastify.httpErrors.conflict("Action plan already exists for this project");

  // Find template
  let templateId = input.templateId;
  if (!templateId) {
    // Find default template for this project type
    const defaultTemplate = await fastify.prisma.workflowTemplate.findFirst({
      where: {
        OR: [{ tenantId }, { tenantId: null }],
        projectType: project.type,
        isDefault: true,
        isActive: true,
      },
      // Prefer tenant-specific over system default
      orderBy: { tenantId: "desc" },
    });
    if (!defaultTemplate)
      throw fastify.httpErrors.notFound(
        "No default template found for this project type"
      );
    templateId = defaultTemplate.id;
  }

  const template = await fastify.prisma.workflowTemplate.findFirst({
    where: {
      id: templateId,
      OR: [{ tenantId }, { tenantId: null }],
      isActive: true,
    },
    include: {
      steps: { orderBy: { sortOrder: "asc" } },
    },
  });
  if (!template)
    throw fastify.httpErrors.notFound("Template not found");

  // Filter steps: include non-selectable + selected ones
  const selectedOrders = new Set(input.selectedStepOrders);
  const filteredSteps = template.steps.filter(
    (step) =>
      !step.isSelectable || selectedOrders.has(step.sortOrder)
  );

  // Build sortOrder-to-taskId mapping for dependency resolution
  const sortOrderToIndex = new Map<number, number>();
  filteredSteps.forEach((step, index) => {
    sortOrderToIndex.set(step.sortOrder, index);
  });

  return fastify.prisma.$transaction(async (tx) => {
    const plan = await tx.actionPlan.create({
      data: {
        tenantId,
        projectId,
        templateId,
      },
    });

    // Create tasks in order, resolving dependencies
    const createdTasks: { id: string; sortOrder: number }[] = [];

    for (let i = 0; i < filteredSteps.length; i++) {
      const step = filteredSteps[i];

      // Resolve dependency
      let dependsOnTaskId: string | null = null;
      if (step.dependsOnStepOrder !== null && step.dependsOnStepOrder !== undefined) {
        if (step.dependsOnStepOrder === -1) {
          // No dependency (parallel, standalone)
          dependsOnTaskId = null;
        } else {
          // Find the task created from the referenced step
          const depIndex = sortOrderToIndex.get(step.dependsOnStepOrder);
          if (depIndex !== undefined && createdTasks[depIndex]) {
            dependsOnTaskId = createdTasks[depIndex].id;
          }
        }
      } else if (i > 0) {
        // Default: depends on previous task
        dependsOnTaskId = createdTasks[i - 1].id;
      }

      const task = await tx.actionTask.create({
        data: {
          actionPlanId: plan.id,
          sortOrder: i,
          name: step.name,
          description: step.description,
          institution: step.institution,
          estimatedDays: step.estimatedDays,
          dependsOnTaskId,
        },
      });

      createdTasks.push({ id: task.id, sortOrder: step.sortOrder });
    }

    return tx.actionPlan.findUnique({
      where: { id: plan.id },
      include: planInclude,
    });
  });
}

export async function updateTask(
  fastify: FastifyInstance,
  tenantId: string,
  taskId: string,
  input: UpdateTaskInput
) {
  const task = await fastify.prisma.actionTask.findFirst({
    where: {
      id: taskId,
      actionPlan: { tenantId },
    },
    include: { dependsOnTask: { select: { status: true } } },
  });
  if (!task) throw fastify.httpErrors.notFound("Task not found");

  // Auto-set dates based on status changes
  const data: any = { ...input };

  if (input.status === "WAITING" && task.status !== "WAITING") {
    if (!data.startDate && !task.startDate) {
      data.startDate = new Date();
    }
    if (!data.dueDate && !task.dueDate && task.estimatedDays) {
      const start = data.startDate || task.startDate || new Date();
      const due = new Date(start);
      due.setDate(due.getDate() + task.estimatedDays);
      data.dueDate = due;
    }
  }

  if (input.status === "COMPLETED" && task.status !== "COMPLETED") {
    data.completedDate = new Date();
  }

  // Parse date strings to Date objects
  if (data.startDate && typeof data.startDate === "string") {
    data.startDate = new Date(data.startDate);
  }
  if (data.dueDate && typeof data.dueDate === "string") {
    data.dueDate = new Date(data.dueDate);
  }

  return fastify.prisma.actionTask.update({
    where: { id: taskId },
    data,
    include: taskInclude,
  });
}

export async function addTask(
  fastify: FastifyInstance,
  tenantId: string,
  projectId: string,
  input: CreateTaskInput
) {
  const plan = await fastify.prisma.actionPlan.findFirst({
    where: { projectId, tenantId },
  });
  if (!plan)
    throw fastify.httpErrors.notFound("Action plan not found for this project");

  return fastify.prisma.actionTask.create({
    data: {
      actionPlanId: plan.id,
      sortOrder: input.sortOrder,
      name: input.name,
      description: input.description,
      institution: input.institution,
      estimatedDays: input.estimatedDays,
      dependsOnTaskId: input.dependsOnTaskId,
    },
    include: taskInclude,
  });
}

export async function removeTask(
  fastify: FastifyInstance,
  tenantId: string,
  taskId: string
) {
  const task = await fastify.prisma.actionTask.findFirst({
    where: {
      id: taskId,
      actionPlan: { tenantId },
    },
    include: { dependentTasks: { select: { id: true } } },
  });
  if (!task) throw fastify.httpErrors.notFound("Task not found");

  // Reconnect dependent tasks to this task's parent
  if (task.dependentTasks.length > 0) {
    await fastify.prisma.actionTask.updateMany({
      where: { dependsOnTaskId: taskId },
      data: { dependsOnTaskId: task.dependsOnTaskId },
    });
  }

  return fastify.prisma.actionTask.delete({ where: { id: taskId } });
}

export async function reorderTasks(
  fastify: FastifyInstance,
  tenantId: string,
  projectId: string,
  input: ReorderTasksInput
) {
  const plan = await fastify.prisma.actionPlan.findFirst({
    where: { projectId, tenantId },
  });
  if (!plan)
    throw fastify.httpErrors.notFound("Action plan not found for this project");

  await fastify.prisma.$transaction(
    input.tasks.map((t) =>
      fastify.prisma.actionTask.update({
        where: { id: t.id },
        data: { sortOrder: t.sortOrder },
      })
    )
  );

  return fastify.prisma.actionPlan.findUnique({
    where: { id: plan.id },
    include: planInclude,
  });
}

export async function getDeadlines(
  fastify: FastifyInstance,
  tenantId: string,
  daysAhead: number = 7,
  includeOverdue: boolean = true
) {
  const now = new Date();
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + daysAhead);

  const where: any = {
    actionPlan: { tenantId },
    status: { in: ["WAITING", "IN_PROGRESS"] },
    dueDate: { not: null },
  };

  if (includeOverdue) {
    where.dueDate = { lte: futureDate };
  } else {
    where.dueDate = { gte: now, lte: futureDate };
  }

  return fastify.prisma.actionTask.findMany({
    where,
    include: {
      actionPlan: {
        include: {
          project: {
            select: {
              id: true,
              name: true,
              type: true,
              client: {
                select: {
                  id: true,
                  companyName: true,
                  firstName: true,
                  lastName: true,
                },
              },
            },
          },
        },
      },
    },
    orderBy: { dueDate: "asc" },
  });
}
