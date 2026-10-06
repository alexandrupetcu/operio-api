import type { Prisma, PrismaClient } from "@prisma/client";
import { sendWebPush } from "../../lib/web-push.js";
import { sendExpoPush } from "../../lib/expo-push.js";
import { sendNotificationEmail } from "../../lib/email.js";

export type NotifCategory = "projects" | "fleet" | "tasks" | "system";

/** Channels the dispatch layer fans out to. Mobile `expo_push` is added in F6. */
export const DISPATCH_CHANNELS = ["in_app", "email", "web_push"] as const;
export type DispatchChannel = (typeof DISPATCH_CHANNELS)[number];

export interface DispatchEvent {
  userId: string;
  category: NotifCategory;
  subject: string;
  body: string;
  /** Deep link used for push payload / click-through. */
  url?: string;
  /** Idempotency key: "due:<kind>:<id>:<yyyy-mm-dd>". */
  dedupeKey?: string;
  clientId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  vehicleId?: string | null;
  workflowInstanceId?: string | null;
}

/** Enabled channels for (user, category). Default-on: only opt-out rows exist. */
async function enabledChannels(
  prisma: PrismaClient,
  tenantId: string,
  userId: string,
  category: string,
): Promise<Set<DispatchChannel>> {
  const prefs = await prisma.notificationPreference.findMany({
    where: { tenantId, userId, category },
    select: { channel: true, enabled: true },
  });
  const disabled = new Set(prefs.filter((p) => !p.enabled).map((p) => p.channel));
  return new Set(DISPATCH_CHANNELS.filter((c) => !disabled.has(c)));
}

/**
 * Deliver one event to a user across their enabled channels, recording one
 * Notification row per channel. Idempotent on `dedupeKey` (skips if any row for
 * this user already carries the same key). Returns whether it was skipped.
 */
export async function dispatch(
  prisma: PrismaClient,
  tenantId: string,
  ev: DispatchEvent,
): Promise<{ skipped: boolean }> {
  if (ev.dedupeKey) {
    const existing = await prisma.notification.findFirst({
      where: { tenantId, userId: ev.userId, dedupeKey: ev.dedupeKey },
      select: { id: true },
    });
    if (existing) return { skipped: true };
  }

  const channels = await enabledChannels(prisma, tenantId, ev.userId, ev.category);
  if (channels.size === 0) return { skipped: false };

  const relations = {
    ...(ev.clientId ? { clientId: ev.clientId } : {}),
    ...(ev.projectId ? { projectId: ev.projectId } : {}),
    ...(ev.taskId ? { taskId: ev.taskId } : {}),
    ...(ev.vehicleId ? { vehicleId: ev.vehicleId } : {}),
    ...(ev.workflowInstanceId ? { workflowInstanceId: ev.workflowInstanceId } : {}),
  };
  const base = {
    tenantId,
    userId: ev.userId,
    category: ev.category,
    subject: ev.subject,
    body: ev.body,
    dedupeKey: ev.dedupeKey ?? null,
    metadataJson: (ev.url ? { url: ev.url } : undefined) as Prisma.InputJsonValue | undefined,
    ...relations,
  };

  // in_app: the row IS the delivery. "Unread" = status "sent" + sentAt null.
  if (channels.has("in_app")) {
    await prisma.notification.create({
      data: { ...base, channel: "in_app", status: "sent" },
    });
  }

  // email
  if (channels.has("email")) {
    const user = await prisma.user.findUnique({
      where: { id: ev.userId },
      select: { email: true },
    });
    let status = "sent";
    let providerResponseJson: Prisma.InputJsonValue | undefined;
    if (user?.email) {
      try {
        await sendNotificationEmail({ to: user.email, subject: ev.subject, body: ev.body, url: ev.url });
      } catch (e) {
        status = "failed";
        providerResponseJson = { error: e instanceof Error ? e.message : String(e) };
      }
    } else {
      status = "failed";
      providerResponseJson = { error: "user has no email" };
    }
    await prisma.notification.create({
      data: {
        ...base,
        channel: "email",
        status,
        sentAt: status === "sent" ? new Date() : null,
        providerResponseJson,
      },
    });
  }

  // web_push: fan out to all of the user's browser subscriptions; prune expired.
  if (channels.has("web_push")) {
    const subs = await prisma.webPushSubscription.findMany({
      where: { tenantId, userId: ev.userId },
    });
    let anyOk = false;
    const errors: string[] = [];
    for (const s of subs) {
      const r = await sendWebPush(s, {
        title: ev.subject,
        body: ev.body,
        url: ev.url,
        tag: ev.dedupeKey,
      });
      if (r.ok) anyOk = true;
      else {
        errors.push(r.error);
        if (r.expired) {
          await prisma.webPushSubscription.delete({ where: { id: s.id } }).catch(() => {});
        }
      }
    }
    if (subs.length > 0) {
      await prisma.notification.create({
        data: {
          ...base,
          channel: "web_push",
          status: anyOk ? "sent" : "failed",
          sentAt: anyOk ? new Date() : null,
          providerResponseJson: errors.length ? ({ errors } as Prisma.InputJsonValue) : undefined,
        },
      });
    }

    // Mobile (Expo) push — same "push" preference governs browser + phone.
    const devices = await prisma.pushDevice.findMany({ where: { tenantId, userId: ev.userId } });
    if (devices.length > 0) {
      const result = await sendExpoPush(
        devices.map((d) => d.expoToken),
        { title: ev.subject, body: ev.body, url: ev.url },
      );
      if (result.invalidTokens.length > 0) {
        await prisma.pushDevice
          .deleteMany({ where: { expoToken: { in: result.invalidTokens } } })
          .catch(() => {});
      }
      await prisma.notification.create({
        data: {
          ...base,
          channel: "expo_push",
          status: result.ok ? "sent" : "failed",
          sentAt: result.ok ? new Date() : null,
          providerResponseJson: result.errors.length ? ({ errors: result.errors } as Prisma.InputJsonValue) : undefined,
        },
      });
    }
  }

  return { skipped: false };
}

/**
 * Workflow-event fan-out: deliver to a specific user when the event has an
 * assignee, otherwise to all office staff (ADMIN/MANAGER) — the same audience
 * that previously saw the tenant-wide in-app rows. Each recipient goes through
 * dispatch(), so per-user channel preferences (in-app/email/push) apply.
 */
export async function dispatchWorkflowEvent(
  prisma: PrismaClient,
  tenantId: string,
  ev: Omit<DispatchEvent, "userId"> & { userId?: string | null },
): Promise<{ sent: number }> {
  let recipients: string[];
  if (ev.userId) {
    recipients = [ev.userId];
  } else {
    const staff = await prisma.user.findMany({
      where: { tenantId, isActive: true, role: { in: ["ADMIN", "MANAGER"] } },
      select: { id: true },
    });
    recipients = staff.map((u) => u.id);
  }

  let sent = 0;
  for (const userId of recipients) {
    const r = await dispatch(prisma, tenantId, { ...ev, userId });
    if (!r.skipped) sent++;
  }
  return { sent };
}
