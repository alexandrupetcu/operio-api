import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { Queue } from "bullmq";
import { redisConnection } from "../../config/redis.js";
import type { PaginationQuery } from "../../lib/pagination.js";
import { paginationArgs, paginationMeta } from "../../lib/pagination.js";
import type { CreateTaskInput, UpdateTaskInput } from "./tasks.schema.js";

// Shared BullMQ queue for engine-level jobs (activate_step, mark_step_overdue,
// send_notification, send_reminder, mark_task_overdue, send_task_reminder)
const workflowQueue = new Queue("workflow-engine", { connection: redisConnection });

// Reminder is fired this many ms before dueAt
const TASK_REMINDER_LEAD_MS = 24 * 3600 * 1000;

/**
 * Create an in-app Notification row for an assigned task + enqueue an immediate
 * BullMQ send_notification job so the worker picks it up.
 *
 * Idempotency note: caller decides when to call (typically: task created with
 * assignee, or assignee changed on update).
 */
async function notifyTaskAssignee(
  fastify: FastifyInstance,
  tenantId: string,
  task: {
    id: string;
    title: string;
    projectId: string | null;
    assignedUserId: string | null;
    dueAt: Date | null;
  },
  variant: "assigned" | "reminder" | "overdue"
) {
  if (!task.assignedUserId) return;

  const subject = (() => {
    switch (variant) {
      case "assigned":
        return `Task nou: ${task.title}`;
      case "reminder":
        return `Reminder task: ${task.title}`;
      case "overdue":
        return `Task întârziat: ${task.title}`;
    }
  })();

  const body = (() => {
    const dueLabel = task.dueAt ? ` (scadență: ${task.dueAt.toISOString()})` : "";
    switch (variant) {
      case "assigned":
        return `Ai fost asignat la "${task.title}"${dueLabel}.`;
      case "reminder":
        return `Task-ul "${task.title}" expiră în mai puțin de 24h${dueLabel}.`;
      case "overdue":
        return `Task-ul "${task.title}" a depășit termenul${dueLabel}.`;
    }
  })();

  const notification = await fastify.prisma.notification.create({
    data: {
      tenantId,
      userId: task.assignedUserId,
      projectId: task.projectId,
      taskId: task.id,
      channel: "in_app",
      subject,
      body,
      status: "pending",
    },
  });

  // Enqueue immediate delivery via BullMQ so worker actually fires it
  await workflowQueue.add(
    "send_notification",
    {
      type: "send_notification",
      tenantId,
      notificationId: notification.id,
    },
    { removeOnComplete: 100, removeOnFail: 100 }
  );
}

/**
 * Schedule a reminder job (~24h before dueAt) and an overdue job (at dueAt).
 * Both go directly into the workflow-engine BullMQ queue as delayed jobs.
 */
async function scheduleTaskDeadlineJobs(
  tenantId: string,
  task: { id: string; dueAt: Date | null }
) {
  if (!task.dueAt) return;

  const now = Date.now();
  const dueAtMs = task.dueAt.getTime();
  const reminderAt = dueAtMs - TASK_REMINDER_LEAD_MS;

  if (reminderAt > now) {
    await workflowQueue.add(
      "send_task_reminder",
      { type: "send_task_reminder", tenantId, taskId: task.id },
      { delay: reminderAt - now, removeOnComplete: 100, removeOnFail: 100 }
    );
  }

  if (dueAtMs > now) {
    await workflowQueue.add(
      "mark_task_overdue",
      { type: "mark_task_overdue", tenantId, taskId: task.id },
      { delay: dueAtMs - now, removeOnComplete: 100, removeOnFail: 100 }
    );
  }
}

const listInclude = {
  project: { select: { id: true, name: true, status: true } },
  client: { select: { id: true, companyName: true, firstName: true, lastName: true } },
  assignedUser: { select: { id: true, firstName: true, lastName: true, email: true } },
} as const;

const detailInclude = {
  project: { select: { id: true, name: true, status: true } },
  client: { select: { id: true, companyName: true, firstName: true, lastName: true } },
  assignedUser: { select: { id: true, firstName: true, lastName: true, email: true } },
  workflowInstance: { select: { id: true, status: true } },
  workflowStepInstance: { select: { id: true, stepName: true, status: true } },
} as const;

export async function list(
  fastify: FastifyInstance,
  tenantId: string,
  query: PaginationQuery & {
    status?: string;
    assignedUserId?: string;
    projectId?: string;
    workflowInstanceId?: string;
    /** Comma-separated list of task types to include (e.g. "manual,followup") */
    taskType?: string;
    /** Comma-separated list of task types to exclude (e.g. "workflow_generated") */
    excludeTaskType?: string;
  }
) {
  const taskTypeIn = query.taskType?.split(",").map((s) => s.trim()).filter(Boolean);
  const taskTypeNotIn = query.excludeTaskType?.split(",").map((s) => s.trim()).filter(Boolean);

  const where: Prisma.TaskWhereInput = {
    tenantId,
    deletedAt: null,
    ...(query.status && { status: query.status }),
    ...(query.assignedUserId && { assignedUserId: query.assignedUserId }),
    ...(query.projectId && { projectId: query.projectId }),
    ...(query.workflowInstanceId && { workflowInstanceId: query.workflowInstanceId }),
    ...(taskTypeIn?.length && { taskType: { in: taskTypeIn } }),
    ...(taskTypeNotIn?.length && { taskType: { notIn: taskTypeNotIn } }),
    ...(query.search && {
      OR: [
        { title: { contains: query.search, mode: "insensitive" as const } },
        { description: { contains: query.search, mode: "insensitive" as const } },
      ],
    }),
  };

  const [data, total] = await Promise.all([
    fastify.prisma.task.findMany({
      where,
      include: listInclude,
      ...paginationArgs(query),
    }),
    fastify.prisma.task.count({ where }),
  ]);

  return { data, ...paginationMeta(total, query) };
}

export async function getById(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const task = await fastify.prisma.task.findFirst({
    where: { id, tenantId, deletedAt: null },
    include: detailInclude,
  });
  if (!task) throw fastify.httpErrors.notFound("Task not found");
  return task;
}

export async function create(
  fastify: FastifyInstance,
  tenantId: string,
  input: CreateTaskInput
) {
  const task = await fastify.prisma.task.create({
    data: {
      tenantId,
      title: input.title,
      description: input.description,
      taskType: input.taskType,
      status: input.status,
      priority: input.priority,
      projectId: input.projectId,
      clientId: input.clientId,
      workflowInstanceId: input.workflowInstanceId,
      workflowStepInstanceId: input.workflowStepInstanceId,
      assignedUserId: input.assignedUserId,
      dueAt: input.dueAt ? new Date(input.dueAt) : undefined,
      metadataJson: input.metadataJson as Prisma.InputJsonValue | undefined,
    },
    include: listInclude,
  });

  // Fire-and-forget — never fail task creation because of notification glitches
  if (task.assignedUserId) {
    notifyTaskAssignee(fastify, tenantId, task, "assigned").catch((err) =>
      fastify.log.error({ err, taskId: task.id }, "notifyTaskAssignee failed")
    );
  }
  if (task.dueAt) {
    scheduleTaskDeadlineJobs(tenantId, task).catch((err) =>
      fastify.log.error({ err, taskId: task.id }, "scheduleTaskDeadlineJobs failed")
    );
  }

  return task;
}

export async function update(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
  input: UpdateTaskInput
) {
  const task = await fastify.prisma.task.findFirst({
    where: { id, tenantId, deletedAt: null },
  });
  if (!task) throw fastify.httpErrors.notFound("Task not found");

  // Auto-set completedAt when status transitions to "done", unless explicitly provided
  let completedAt: Date | null | undefined = undefined;
  if (input.completedAt !== undefined) {
    completedAt = input.completedAt ? new Date(input.completedAt) : null;
  } else if (input.status === "done" && task.status !== "done") {
    completedAt = new Date();
  }

  const updated = await fastify.prisma.task.update({
    where: { id },
    data: {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.priority !== undefined && { priority: input.priority }),
      ...(input.assignedUserId !== undefined && { assignedUserId: input.assignedUserId }),
      ...(input.dueAt !== undefined && {
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
      }),
      ...(input.metadataJson !== undefined && {
        metadataJson: input.metadataJson as Prisma.InputJsonValue,
      }),
      ...(completedAt !== undefined && { completedAt }),
    },
    include: listInclude,
  });

  // Notify on assignee change (only if NEW assignee differs from previous)
  const assigneeChanged =
    input.assignedUserId !== undefined &&
    input.assignedUserId !== null &&
    input.assignedUserId !== task.assignedUserId;
  if (assigneeChanged) {
    notifyTaskAssignee(fastify, tenantId, updated, "assigned").catch((err) =>
      fastify.log.error({ err, taskId: updated.id }, "notifyTaskAssignee (update) failed")
    );
  }

  // If dueAt changed to a new future date, schedule fresh deadline jobs.
  // (Stale jobs from the old dueAt will fire but handlers check task state and skip.)
  const dueAtChanged =
    input.dueAt !== undefined &&
    input.dueAt !== null &&
    (!task.dueAt || new Date(input.dueAt).getTime() !== task.dueAt.getTime());
  if (dueAtChanged) {
    scheduleTaskDeadlineJobs(tenantId, updated).catch((err) =>
      fastify.log.error({ err, taskId: updated.id }, "scheduleTaskDeadlineJobs (update) failed")
    );
  }

  return updated;
}

export async function complete(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const task = await fastify.prisma.task.findFirst({
    where: { id, tenantId, deletedAt: null },
  });
  if (!task) throw fastify.httpErrors.notFound("Task not found");

  return fastify.prisma.task.update({
    where: { id },
    data: {
      status: "done",
      completedAt: new Date(),
    },
    include: listInclude,
  });
}

export async function remove(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const task = await fastify.prisma.task.findFirst({
    where: { id, tenantId, deletedAt: null },
  });
  if (!task) throw fastify.httpErrors.notFound("Task not found");

  return fastify.prisma.task.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
}
