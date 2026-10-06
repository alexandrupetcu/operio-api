import { Worker, type Job } from "bullmq";
import { PrismaClient } from "@prisma/client";
import { redisConnection } from "../config/redis.js";
import { isTenantEventEnabled } from "../modules/notifications/tenant-settings.js";
import { dispatchWorkflowEvent } from "../modules/notifications/dispatch.js";

interface ActivateStepJobData {
  type: "activate_step";
  tenantId: string;
  workflowStepInstanceId: string;
}

interface MarkStepOverdueJobData {
  type: "mark_step_overdue";
  tenantId: string;
  workflowStepInstanceId: string;
}

interface SendNotificationJobData {
  type: "send_notification";
  tenantId: string;
  notificationId: string;
}

interface SendReminderJobData {
  type: "send_reminder";
  tenantId: string;
  /** Legacy field from ScheduledJob-based scheduling — not required for BullMQ direct flow */
  scheduledJobId?: string;
  workflowInstanceId: string;
  projectId: string | null;
  channel: string;
  subject: string | null;
  body: string;
}

interface SendTaskReminderJobData {
  type: "send_task_reminder";
  tenantId: string;
  taskId: string;
}

interface MarkTaskOverdueJobData {
  type: "mark_task_overdue";
  tenantId: string;
  taskId: string;
}

type WorkflowJobData =
  | ActivateStepJobData
  | MarkStepOverdueJobData
  | SendNotificationJobData
  | SendReminderJobData
  | SendTaskReminderJobData
  | MarkTaskOverdueJobData;

const prisma = new PrismaClient();

async function handleActivateStep(data: ActivateStepJobData) {
  const step = await prisma.workflowStepInstance.findFirst({
    where: {
      id: data.workflowStepInstanceId,
      workflowInstance: { tenantId: data.tenantId },
    },
  });

  if (!step) {
    console.warn(
      `Step instance ${data.workflowStepInstanceId} not found, skipping`
    );
    return { skipped: true };
  }

  if (step.status !== "pending") {
    console.warn(
      `Step instance ${data.workflowStepInstanceId} is not pending (status: ${step.status}), skipping`
    );
    return { skipped: true };
  }

  await prisma.workflowStepInstance.update({
    where: { id: data.workflowStepInstanceId },
    data: {
      status: "active",
      startedAt: new Date(),
    },
  });

  return { activated: true, stepInstanceId: data.workflowStepInstanceId };
}

async function handleMarkStepOverdue(data: MarkStepOverdueJobData) {
  const step = await prisma.workflowStepInstance.findFirst({
    where: {
      id: data.workflowStepInstanceId,
      workflowInstance: { tenantId: data.tenantId },
    },
    include: {
      stepDefinition: { select: { name: true } },
      workflowInstance: { select: { entityId: true, entityType: true } },
    },
  });

  if (!step) {
    console.warn(
      `Step instance ${data.workflowStepInstanceId} not found, skipping`
    );
    return { skipped: true };
  }

  if (step.status !== "active" && step.status !== "pending") {
    console.warn(
      `Step instance ${data.workflowStepInstanceId} is not active/pending (status: ${step.status}), skipping`
    );
    return { skipped: true };
  }

  if (step.dueAt && step.dueAt > new Date()) {
    console.warn(
      `Step instance ${data.workflowStepInstanceId} is not past due yet, skipping`
    );
    return { skipped: true };
  }

  await prisma.workflowStepInstance.update({
    where: { id: data.workflowStepInstanceId },
    data: { status: "overdue" },
  });

  // Notify the assignee (if any). Mirrors mark_task_overdue behavior.
  if (step.assignedUserId && (await isTenantEventEnabled(prisma, data.tenantId, "workflow_events"))) {
    const stepName = step.displayName || step.stepDefinition?.name || "Step workflow";
    const projectId =
      step.workflowInstance?.entityType === "project"
        ? step.workflowInstance.entityId
        : null;
    await dispatchWorkflowEvent(prisma, data.tenantId, {
      userId: step.assignedUserId,
      category: "projects",
      subject: `Step întârziat: ${stepName}`,
      body: `Pasul "${stepName}" a depășit termenul${
        step.dueAt ? ` (scadență: ${step.dueAt.toLocaleDateString("ro-RO")})` : ""
      }.`,
      url: projectId ? `/projects/${projectId}` : "/dashboard",
      dedupeKey: `wf:step_overdue:${data.workflowStepInstanceId}`,
      projectId,
      workflowInstanceId: step.workflowInstanceId,
    });
  }

  return { markedOverdue: true, stepInstanceId: data.workflowStepInstanceId };
}

async function handleSendNotification(data: SendNotificationJobData) {
  const notification = await prisma.notification.findFirst({
    where: {
      id: data.notificationId,
      tenantId: data.tenantId,
    },
  });

  if (!notification) {
    console.warn(
      `Notification ${data.notificationId} not found, skipping`
    );
    return { skipped: true };
  }

  if (notification.status !== "pending" && notification.status !== "scheduled") {
    console.warn(
      `Notification ${data.notificationId} is not pending/scheduled (status: ${notification.status}), skipping`
    );
    return { skipped: true };
  }

  // For now, just mark the notification as sent.
  // Future: integrate with email/SMS/webhook providers based on notification.channel
  await prisma.notification.update({
    where: { id: data.notificationId },
    data: {
      status: "sent",
      sentAt: new Date(),
    },
  });

  return { sent: true, notificationId: data.notificationId };
}

async function handleSendReminder(data: SendReminderJobData) {
  // Check if the related workflow instance is still running
  const instance = await prisma.workflowInstance.findFirst({
    where: {
      id: data.workflowInstanceId,
      tenantId: data.tenantId,
    },
    select: { status: true },
  });

  // Skip reminders if the workflow is no longer running
  if (!instance || instance.status !== "running") {
    console.log(
      `Workflow ${data.workflowInstanceId} is no longer running, skipping reminder`
    );
    return { skipped: true, reason: "workflow_not_running" };
  }

  // Tenant-level switch: workflow reminders can be muted firm-wide.
  if (!(await isTenantEventEnabled(prisma, data.tenantId, "workflow_events"))) {
    return { skipped: true, reason: "tenant_disabled" };
  }

  // Fan out through dispatch — office staff, per-user channel preferences.
  const result = await dispatchWorkflowEvent(prisma, data.tenantId, {
    category: "projects",
    subject: data.subject ?? "Reminder workflow",
    body: data.body ?? "Reminder notification",
    url: data.projectId ? `/projects/${data.projectId}` : "/dashboard",
    projectId: data.projectId,
    workflowInstanceId: data.workflowInstanceId,
  });

  return { sent: result.sent, workflowInstanceId: data.workflowInstanceId };
}

async function handleSendTaskReminder(data: SendTaskReminderJobData) {
  const task = await prisma.task.findFirst({
    where: { id: data.taskId, tenantId: data.tenantId, deletedAt: null },
  });
  if (!task) return { skipped: true, reason: "task_not_found" };
  if (task.status === "done" || task.status === "cancelled") {
    return { skipped: true, reason: `task_${task.status}` };
  }
  if (!task.assignedUserId) {
    return { skipped: true, reason: "no_assignee" };
  }
  if (!(await isTenantEventEnabled(prisma, data.tenantId, "task_overdue"))) {
    return { skipped: true, reason: "tenant_disabled" };
  }

  await dispatchWorkflowEvent(prisma, data.tenantId, {
    userId: task.assignedUserId,
    category: "tasks",
    subject: `Reminder task: ${task.title}`,
    body: `Task-ul "${task.title}" expiră în mai puțin de 24h${task.dueAt ? ` (scadență: ${task.dueAt.toLocaleDateString("ro-RO")})` : ""}.`,
    url: task.projectId ? `/projects/${task.projectId}` : "/dashboard",
    dedupeKey: `wf:task_reminder:${task.id}`,
    projectId: task.projectId,
    taskId: task.id,
  });

  return { reminded: true, taskId: task.id };
}

async function handleMarkTaskOverdue(data: MarkTaskOverdueJobData) {
  const task = await prisma.task.findFirst({
    where: { id: data.taskId, tenantId: data.tenantId, deletedAt: null },
  });
  if (!task) return { skipped: true, reason: "task_not_found" };
  if (task.status === "done" || task.status === "cancelled") {
    return { skipped: true, reason: `task_${task.status}` };
  }
  if (task.status === "overdue") {
    return { skipped: true, reason: "already_overdue" };
  }
  // Sanity: only mark overdue if dueAt actually passed
  if (task.dueAt && task.dueAt > new Date()) {
    return { skipped: true, reason: "not_yet_due" };
  }

  await prisma.task.update({
    where: { id: task.id },
    data: { status: "overdue" },
  });

  if (task.assignedUserId && (await isTenantEventEnabled(prisma, data.tenantId, "task_overdue"))) {
    await dispatchWorkflowEvent(prisma, data.tenantId, {
      userId: task.assignedUserId,
      category: "tasks",
      subject: `Task întârziat: ${task.title}`,
      body: `Task-ul "${task.title}" a depășit termenul${task.dueAt ? ` (scadență: ${task.dueAt.toLocaleDateString("ro-RO")})` : ""}.`,
      url: task.projectId ? `/projects/${task.projectId}` : "/dashboard",
      dedupeKey: `wf:task_overdue:${task.id}`,
      projectId: task.projectId,
      taskId: task.id,
    });
  }

  return { overdue: true, taskId: task.id };
}

async function processJob(job: Job<WorkflowJobData>) {
  const { data } = job;

  switch (data.type) {
    case "activate_step":
      return handleActivateStep(data);
    case "mark_step_overdue":
      return handleMarkStepOverdue(data);
    case "send_notification":
      return handleSendNotification(data);
    case "send_reminder":
      return handleSendReminder(data);
    case "send_task_reminder":
      return handleSendTaskReminder(data);
    case "mark_task_overdue":
      return handleMarkTaskOverdue(data);
    default:
      throw new Error(`Unknown job type: ${(data as any).type}`);
  }
}

// Start worker
async function main() {
  const worker = new Worker("workflow-engine", processJob, {
    connection: redisConnection,
    concurrency: 3,
  });

  worker.on("completed", (job) => {
    console.log(
      `Job ${job.id} (${job.data.type}) completed`
    );
  });

  worker.on("failed", (job, err) => {
    console.error(
      `Job ${job?.id} (${job?.data.type}) failed:`,
      err.message
    );
  });

  console.log("Workflow engine worker started");

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    await worker.close();
    await prisma.$disconnect();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await worker.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}

main().catch(console.error);
