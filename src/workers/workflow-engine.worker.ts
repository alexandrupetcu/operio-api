import { Worker, type Job } from "bullmq";
import { PrismaClient } from "@prisma/client";
import { redisConnection } from "../config/redis.js";

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
  scheduledJobId: string;
  workflowInstanceId: string;
  projectId: string | null;
  channel: string;
  subject: string | null;
  body: string;
}

type WorkflowJobData =
  | ActivateStepJobData
  | MarkStepOverdueJobData
  | SendNotificationJobData
  | SendReminderJobData;

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

  // Create the reminder notification
  await prisma.notification.create({
    data: {
      tenantId: data.tenantId,
      projectId: data.projectId,
      workflowInstanceId: data.workflowInstanceId,
      channel: data.channel ?? "in_app",
      subject: data.subject ?? null,
      body: data.body ?? "Reminder notification",
      status: "pending",
      metadataJson: { type: "reminder" },
    },
  });

  return { sent: true, workflowInstanceId: data.workflowInstanceId };
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
