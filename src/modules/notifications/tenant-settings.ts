import type { PrismaClient, Prisma } from "@prisma/client";
import { z } from "zod";

/**
 * Tenant-level notification switches — which notification EVENTS the firm
 * emits at all, regardless of per-user channel preferences.
 *
 * Layering:
 *   1. Tenant switch (this file)  — "does the firm send this type at all?"
 *   2. NotificationPreference     — "does THIS user want it on THIS channel?"
 *
 * Stored in `Tenant.settingsJson.notifications` as { [eventKey]: boolean }.
 * Default-on: a missing key means enabled, so only opt-outs are persisted
 * (same semantics as NotificationPreference — no backfill needed).
 */

export const TENANT_NOTIF_EVENTS = [
  {
    key: "appointment_reminder",
    label: "Programări azi / mâine",
    description: "Digest la 07:00 și 13:00 cu programările din calendar pentru azi și mâine.",
    group: "Programări",
  },
  {
    key: "task_due",
    label: "Activități scadente azi / mâine",
    description: "Digest cu task-urile care au termen azi sau mâine, către persoana asignată.",
    group: "Activități",
  },
  {
    key: "fleet_expiry",
    label: "Expirări flotă (ITP / RCA / Rovinietă)",
    description: "Digest cu vehiculele ale căror ITP, RCA sau rovinietă expiră azi sau mâine.",
    group: "Flotă",
  },
  {
    key: "task_overdue",
    label: "Task-uri întârziate & remindere",
    description: "Notificări instant când un task depășește termenul sau expiră în mai puțin de 24h.",
    group: "Activități",
  },
  {
    key: "workflow_events",
    label: "Proiecte & workflow",
    description: "Notificări instant din workflow-uri: pași finalizați/întârziați, documente generate, notificări configurate în Constructor.",
    group: "Proiecte",
  },
] as const;

export type TenantNotifEventKey = (typeof TENANT_NOTIF_EVENTS)[number]["key"];

const EVENT_KEYS = TENANT_NOTIF_EVENTS.map((e) => e.key) as [TenantNotifEventKey, ...TenantNotifEventKey[]];

export const tenantSettingsUpdateSchema = z.object({
  events: z
    .array(z.object({ key: z.enum(EVENT_KEYS), enabled: z.boolean() }))
    .max(TENANT_NOTIF_EVENTS.length),
});

interface SettingsJson {
  notifications?: Record<string, boolean>;
  [k: string]: unknown;
}

function readMap(settingsJson: unknown): Record<string, boolean> {
  const s = settingsJson && typeof settingsJson === "object" ? (settingsJson as SettingsJson) : {};
  return s.notifications && typeof s.notifications === "object" ? s.notifications : {};
}

/** Full registry with each event's effective enabled value (default-on). */
export async function getTenantNotifSettings(prisma: PrismaClient, tenantId: string) {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { settingsJson: true },
  });
  const map = readMap(tenant.settingsJson);
  return {
    events: TENANT_NOTIF_EVENTS.map((e) => ({
      key: e.key,
      label: e.label,
      description: e.description,
      group: e.group,
      enabled: map[e.key] ?? true,
    })),
  };
}

/** Fast lookup used by producers before emitting an event. Default-on. */
export async function isTenantEventEnabled(
  prisma: PrismaClient,
  tenantId: string,
  key: TenantNotifEventKey,
): Promise<boolean> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { settingsJson: true },
  });
  return readMap(tenant?.settingsJson)[key] ?? true;
}

/** Batch variant for the scanner — one read, all switches. */
export async function getTenantEventMap(
  prisma: PrismaClient,
  tenantId: string,
): Promise<Record<TenantNotifEventKey, boolean>> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { settingsJson: true },
  });
  const map = readMap(tenant?.settingsJson);
  return Object.fromEntries(
    TENANT_NOTIF_EVENTS.map((e) => [e.key, map[e.key] ?? true]),
  ) as Record<TenantNotifEventKey, boolean>;
}

/** Merge toggles into settingsJson.notifications (preserves other settings). */
export async function setTenantNotifSettings(
  prisma: PrismaClient,
  tenantId: string,
  events: Array<{ key: string; enabled: boolean }>,
) {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { settingsJson: true },
  });
  const settings = tenant.settingsJson && typeof tenant.settingsJson === "object"
    ? { ...(tenant.settingsJson as SettingsJson) }
    : {};
  const map = { ...readMap(tenant.settingsJson) };
  for (const e of events) map[e.key] = e.enabled;
  settings.notifications = map;
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { settingsJson: settings as Prisma.InputJsonValue },
  });
  return getTenantNotifSettings(prisma, tenantId);
}
