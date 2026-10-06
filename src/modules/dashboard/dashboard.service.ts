import type { FastifyInstance } from "fastify";
import {
  type ApptScope,
  apptVisibilityWhere,
} from "../appointments/scope.js";
import { getAlertWindows, type AlertWindows } from "../tenant/alert-settings.js";

// Warning windows are tenant-configurable (settingsJson.alertWindows); the
// registry defaults in ../tenant/alert-settings.ts carry the historical values
// (2y revision interval, 45d revision warning, 30d fleet, 7d/3d deadlines).

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}
function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

export async function getOverview(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string,
  scope: ApptScope = { kind: "all" }
) {
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const w = await getAlertWindows(fastify.prisma, tenantId);

  const [
    activeProjects,
    openTasks,
    todayAppointments,
    overdueCount,
    fleetExpiringCount,
    emailNeedsReview,
  ] = await Promise.all([
    fastify.prisma.project.count({
      where: {
        tenantId,
        status: { notIn: ["completed", "cancelled", "rejected"] },
      },
    }),
    fastify.prisma.task.count({
      where: {
        tenantId,
        deletedAt: null,
        assignedUserId: userId,
        status: { in: ["open", "in_progress"] },
      },
    }),
    fastify.prisma.appointment.count({
      where: {
        tenantId,
        deletedAt: null,
        date: { gte: todayStart, lte: todayEnd },
        status: { not: "cancelled" },
        // Pentru un tehnician, „programări azi" înseamnă ziua LUI.
        ...apptVisibilityWhere(scope),
      },
    }),
    fastify.prisma.task.count({
      where: {
        tenantId,
        deletedAt: null,
        status: { in: ["open", "in_progress"] },
        dueAt: { lt: now },
      },
    }),
    fastify.prisma.vehicle.count({
      where: {
        tenantId,
        isActive: true,
        OR: [
          { itpExpiry: { lte: addDays(now, w.fleetItpDays) } },
          { insuranceExpiry: { lte: addDays(now, w.fleetRcaDays) } },
          { vignetteExpiry: { lte: addDays(now, w.fleetVignetteDays) } },
        ],
      },
    }),
    fastify.prisma.emailIngestLog.count({
      where: { tenantId, status: "needs_review" },
    }),
  ]);

  return {
    activeProjects,
    openTasks,
    todayAppointments,
    alertsCount: overdueCount + fleetExpiringCount + emailNeedsReview,
  };
}

export async function getAppointmentsUpcoming(
  fastify: FastifyInstance,
  tenantId: string,
  scope: ApptScope = { kind: "all" }
) {
  const now = new Date();
  const from = startOfDay(now);
  const to = endOfDay(addDays(now, 1));

  return fastify.prisma.appointment.findMany({
    where: {
      tenantId,
      deletedAt: null,
      date: { gte: from, lte: to },
      status: { not: "cancelled" },
      ...apptVisibilityWhere(scope),
    },
    include: {
      project: {
        select: {
          id: true,
          name: true,
          projectType: { select: { code: true, name: true } },
        },
      },
      client: {
        select: {
          id: true,
          companyName: true,
          firstName: true,
          lastName: true,
          phone: true,
        },
      },
      employee: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { date: "asc" },
  });
}

export async function getDeadlines(
  fastify: FastifyInstance,
  tenantId: string,
  windows?: AlertWindows
) {
  const now = new Date();
  const w = windows ?? (await getAlertWindows(fastify.prisma, tenantId));
  const upcomingCutoff = endOfDay(addDays(now, w.deadlineUpcomingDays));

  const [tasks, stepInstances] = await Promise.all([
    fastify.prisma.task.findMany({
      where: {
        tenantId,
        deletedAt: null,
        status: { in: ["open", "in_progress"] },
        dueAt: { not: null, lte: upcomingCutoff },
        projectId: { not: null },
      },
      select: {
        id: true,
        title: true,
        dueAt: true,
        priority: true,
        status: true,
        project: { select: { id: true, name: true } },
      },
      orderBy: { dueAt: "asc" },
    }),
    fastify.prisma.workflowStepInstance.findMany({
      where: {
        tenantId,
        // "overdue" included — the engine flips active→overdue when dueAt passes,
        // and those are exactly the steps that must surface in the To-Do feed.
        status: { in: ["pending", "active", "waiting", "overdue"] },
        dueAt: { not: null, lte: upcomingCutoff },
        // Don't resurrect steps of finished/cancelled workflows (non-gating
        // ad-hoc steps can outlive a completed workflow).
        workflowInstance: { status: { in: ["active", "running"] } },
      },
      select: {
        id: true,
        displayName: true,
        dueAt: true,
        workflowInstance: {
          select: {
            entityId: true,
            project: { select: { id: true, name: true } },
          },
        },
        stepDefinition: { select: { name: true } },
      },
      orderBy: { dueAt: "asc" },
    }),
  ]);

  type DeadlineItem = {
    id: string;
    source: "task" | "workflow_step";
    projectId: string | null;
    projectName: string | null;
    title: string;
    dueAt: string;
    daysRemaining: number;
    priority?: string;
    status?: string;
  };

  const items: DeadlineItem[] = [];

  for (const t of tasks) {
    if (!t.dueAt || !t.project) continue;
    const diffMs = t.dueAt.getTime() - now.getTime();
    items.push({
      id: `task-${t.id}`,
      source: "task",
      projectId: t.project.id,
      projectName: t.project.name,
      title: t.title,
      dueAt: t.dueAt.toISOString(),
      daysRemaining: Math.ceil(diffMs / (24 * 3600_000)),
      priority: t.priority,
      status: t.status,
    });
  }

  for (const s of stepInstances) {
    if (!s.dueAt) continue;
    const project = s.workflowInstance?.project;
    const diffMs = s.dueAt.getTime() - now.getTime();
    items.push({
      id: `step-${s.id}`,
      source: "workflow_step",
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      title: s.displayName || s.stepDefinition?.name || "Pas workflow",
      dueAt: s.dueAt.toISOString(),
      daysRemaining: Math.ceil(diffMs / (24 * 3600_000)),
    });
  }

  items.sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());

  return {
    overdue: items.filter((i) => i.daysRemaining < 0),
    urgent: items.filter((i) => i.daysRemaining >= 0 && i.daysRemaining <= w.deadlineUrgentDays),
    upcoming: items.filter(
      (i) => i.daysRemaining > w.deadlineUrgentDays && i.daysRemaining <= w.deadlineUpcomingDays
    ),
  };
}

export async function getExpiringRevisions(
  fastify: FastifyInstance,
  tenantId: string,
  windows?: AlertWindows
) {
  const now = new Date();
  const w = windows ?? (await getAlertWindows(fastify.prisma, tenantId));
  const warningCutoff = addDays(now, w.revisionWarningDays);

  const equipment = await fastify.prisma.equipment.findMany({
    where: {
      client: { tenantId },
      type: "CENTRALA",
    },
    include: {
      revisions: {
        orderBy: { revisionDate: "desc" },
        take: 1,
        select: { revisionDate: true },
      },
      appointments: {
        where: {
          deletedAt: null,
          type: "revizie",
          status: { in: ["scheduled", "in_progress", "awaiting_report"] },
        },
        select: { id: true },
      },
      client: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          companyName: true,
          phone: true,
          email: true,
        },
      },
    },
  });

  const expiring = equipment
    .filter((eq) => eq.appointments.length === 0) // no scheduled revision
    .map((eq) => {
      const last = eq.revisions[0];
      if (!last) return null;
      const expiresAt = new Date(last.revisionDate);
      expiresAt.setFullYear(expiresAt.getFullYear() + w.revisionIntervalYears);
      if (expiresAt > warningCutoff) return null;

      const daysUntilExpiry = Math.ceil(
        (expiresAt.getTime() - now.getTime()) / (24 * 3600_000)
      );

      return {
        equipmentId: eq.id,
        equipmentName: eq.name || eq.internalName || "Centrală",
        clientId: eq.client.id,
        clientName:
          eq.client.companyName ||
          `${eq.client.firstName ?? ""} ${eq.client.lastName ?? ""}`.trim(),
        clientPhone: eq.client.phone,
        clientEmail: eq.client.email,
        lastRevisionDate: last.revisionDate.toISOString(),
        expiresAt: expiresAt.toISOString(),
        daysUntilExpiry,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);

  return expiring;
}

export async function getFleetAlerts(
  fastify: FastifyInstance,
  tenantId: string,
  windows?: AlertWindows
) {
  const now = new Date();
  const w = windows ?? (await getAlertWindows(fastify.prisma, tenantId));
  // Per-type warning windows (a tenant may want ITP at 20 days but RCA at 30).
  const cutoffs = {
    itp: addDays(now, w.fleetItpDays),
    insurance: addDays(now, w.fleetRcaDays),
    vignette: addDays(now, w.fleetVignetteDays),
  } as const;

  // All active vehicles — the mechanical-service due date is computed in JS
  // (last revision + configured km/months intervals), so it can't be filtered
  // in SQL like the document expiries. Fleets are small; this stays cheap.
  const vehicles = await fastify.prisma.vehicle.findMany({
    where: { tenantId, isActive: true },
    select: {
      id: true,
      licensePlate: true,
      make: true,
      model: true,
      itpExpiry: true,
      insuranceExpiry: true,
      vignetteExpiry: true,
      avgKmPerMonth: true,
      revisions: {
        orderBy: { date: "desc" },
        take: 1,
        select: { date: true, km: true },
      },
    },
  });

  type VehicleAlert = {
    id: string;
    licensePlate: string;
    make: string;
    model: string;
    alertType: "itp" | "insurance" | "vignette" | "service";
    expiresAt: string;
    daysUntilExpiry: number;
    /** service only: no revision has ever been recorded for this vehicle. */
    noHistory?: boolean;
  };

  const expired: VehicleAlert[] = [];
  const expiring: VehicleAlert[] = [];
  const serviceCutoff = addDays(now, w.fleetServiceDays);

  for (const v of vehicles) {
    const checks: Array<{ date: Date | null; type: "itp" | "insurance" | "vignette" }> = [
      { date: v.itpExpiry, type: "itp" },
      { date: v.insuranceExpiry, type: "insurance" },
      { date: v.vignetteExpiry, type: "vignette" },
    ];

    for (const { date, type } of checks) {
      if (!date || date > cutoffs[type]) continue;
      const daysUntilExpiry = Math.ceil((date.getTime() - now.getTime()) / (24 * 3600_000));
      const alert: VehicleAlert = {
        id: v.id,
        licensePlate: v.licensePlate,
        make: v.make,
        model: v.model,
        alertType: type,
        expiresAt: date.toISOString(),
        daysUntilExpiry,
      };
      if (daysUntilExpiry < 0) expired.push(alert);
      else expiring.push(alert);
    }

    // Mechanical service (revizie auto): due at whichever comes first —
    // months since the last revision, or the km threshold estimated via the
    // vehicle's avgKmPerMonth. No recorded revision → immediate "no history" alert.
    const last = v.revisions[0];
    if (!last) {
      expired.push({
        id: v.id,
        licensePlate: v.licensePlate,
        make: v.make,
        model: v.model,
        alertType: "service",
        expiresAt: now.toISOString(),
        daysUntilExpiry: 0,
        noHistory: true,
      });
      continue;
    }
    const dateDue = new Date(last.date);
    dateDue.setMonth(dateDue.getMonth() + w.vehicleServiceIntervalMonths);
    let dueAt = dateDue;
    if (v.avgKmPerMonth && v.avgKmPerMonth > 0) {
      const daysToKmDue = (w.vehicleServiceIntervalKm / v.avgKmPerMonth) * 30.44;
      const kmDue = new Date(last.date.getTime() + daysToKmDue * 24 * 3600_000);
      if (kmDue < dueAt) dueAt = kmDue;
    }
    if (dueAt <= serviceCutoff) {
      const daysUntilExpiry = Math.ceil((dueAt.getTime() - now.getTime()) / (24 * 3600_000));
      const alert: VehicleAlert = {
        id: v.id,
        licensePlate: v.licensePlate,
        make: v.make,
        model: v.model,
        alertType: "service",
        expiresAt: dueAt.toISOString(),
        daysUntilExpiry,
      };
      if (daysUntilExpiry < 0) expired.push(alert);
      else expiring.push(alert);
    }
  }

  expired.sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);
  expiring.sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);

  return { expired, expiring };
}

/**
 * Aggregated "De făcut acum" action feed for the dashboard — pulls the most
 * urgent items across every event type (revizii, flotă, task-uri, proiecte) into
 * one prioritized triage list, plus the structured data for the summary strip.
 */
export async function getActionFeed(
  fastify: FastifyInstance,
  tenantId: string,
  _userId: string,
  scope: ApptScope = { kind: "all" }
) {
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const tomorrowStart = startOfDay(addDays(now, 1));
  const tomorrowEnd = endOfDay(addDays(now, 1));
  const w = await getAlertWindows(fastify.prisma, tenantId);
  const deadlineCutoff = endOfDay(addDays(now, w.deadlineUpcomingDays));

  const apptTimeSelect = { select: { date: true } } as const;

  const [revisions, fleet, deadlines, projectDeadlines, activeProjects, todayAppts, tomorrowAppts] =
    await Promise.all([
      getExpiringRevisions(fastify, tenantId, w),
      getFleetAlerts(fastify, tenantId, w),
      getDeadlines(fastify, tenantId, w),
      fastify.prisma.project.findMany({
        where: {
          tenantId,
          status: { notIn: ["completed", "cancelled", "rejected"] },
          scheduledDate: { not: null, lte: deadlineCutoff },
        },
        select: {
          id: true,
          name: true,
          status: true,
          scheduledDate: true,
          projectType: { select: { name: true } },
          client: { select: { companyName: true, firstName: true, lastName: true } },
        },
        orderBy: { scheduledDate: "asc" },
        take: 10,
      }),
      fastify.prisma.project.count({
        where: { tenantId, status: { notIn: ["completed", "cancelled", "rejected"] } },
      }),
      fastify.prisma.appointment.findMany({
        where: { tenantId, deletedAt: null, date: { gte: todayStart, lte: todayEnd }, status: { not: "cancelled" }, ...apptVisibilityWhere(scope) },
        orderBy: { date: "asc" },
        ...apptTimeSelect,
      }),
      fastify.prisma.appointment.findMany({
        where: { tenantId, deletedAt: null, date: { gte: tomorrowStart, lte: tomorrowEnd }, status: { not: "cancelled" }, ...apptVisibilityWhere(scope) },
        orderBy: { date: "asc" },
        ...apptTimeSelect,
      }),
    ]);

  const relTime = (days: number) => (days < 0 ? `ÎNT. ${-days}Z` : days === 0 ? "AZI" : `+${days}Z`);

  type ActionItem = {
    id: string;
    kind: "revision" | "fleet" | "task" | "project";
    time: string;
    title: string;
    meta: string;
    status?: string;
    tag: string;
    tone: "danger" | "warn" | "yellow";
    action: string;
    actionPrimary?: boolean;
    href: string | null;
    phone?: string | null;
    priority: number;
    /** Snapshot of the underlying condition; used to auto-invalidate snooze. */
    conditionRef: string;
    /** Set when this item is currently snoozed by anyone in the tenant. */
    snoozedUntil?: string | null;
    reason?: string | null;
    /** Operator (any in the tenant) who placed the active snooze. */
    snoozedById?: string | null;
    snoozedByName?: string | null;
    /** Tenant-wide snooze history (most recent first, capped). */
    history?: Array<{
      at: string;
      until: string | null;
      note: string | null;
      authorName: string;
      eventType: string;
    }>;
    /** Scheduling context (revision items) for pre-filling the appointment drawer. */
    clientId?: string;
    clientName?: string;
    equipmentId?: string;
    equipmentName?: string;
    /** Scheduling context (fleet items) for creating an ITP/RCA appointment. */
    vehicleId?: string;
    vehiclePlate?: string;
    fleetAlertType?: "itp" | "insurance" | "vignette" | "service";
  };

  const items: ActionItem[] = [];

  // Revizii care expiră
  for (const r of revisions) {
    const d = r.daysUntilExpiry;
    items.push({
      id: `revision-${r.equipmentId}`,
      kind: "revision",
      time: relTime(d),
      title: `${r.clientName} — revizie centrală`,
      meta: [r.equipmentName, r.clientPhone].filter(Boolean).join(" · "),
      tag: d < 0 ? "EXPIRAT" : d === 0 ? "EXPIRĂ AZI" : "CURÂND",
      tone: d <= w.revisionDangerDays ? "danger" : "warn",
      action: "PROGRAMEAZĂ",
      actionPrimary: true,
      href: `/clients/${r.clientId}`,
      phone: r.clientPhone,
      priority: d < 0 ? 0 : d === 0 ? 1 : d <= w.revisionDangerDays ? 2 : 4,
      conditionRef: r.lastRevisionDate,
      clientId: r.clientId,
      clientName: r.clientName,
      equipmentId: r.equipmentId,
      equipmentName: r.equipmentName,
    });
  }

  // Flotă — worst alert per vehicle
  const fleetByVehicle = new Map<string, (typeof fleet.expired)[number]>();
  for (const a of [...fleet.expired, ...fleet.expiring]) {
    const ex = fleetByVehicle.get(a.id);
    if (!ex || a.daysUntilExpiry < ex.daysUntilExpiry) fleetByVehicle.set(a.id, a);
  }
  const TYPE_LABEL = { itp: "ITP", insurance: "RCA", vignette: "Rovinietă", service: "Revizie auto" } as const;
  for (const a of fleetByVehicle.values()) {
    const d = a.daysUntilExpiry;
    const isService = a.alertType === "service";
    const title = a.noHistory
      ? `${a.licensePlate} · fără revizie auto înregistrată`
      : isService
        ? `${a.licensePlate} · Revizie auto ${d < 0 ? "depășită" : "scadentă"}`
        : `${a.licensePlate} · ${TYPE_LABEL[a.alertType]} ${d < 0 ? "expirat" : "expiră"}`;
    items.push({
      id: `fleet-${a.id}`,
      kind: "fleet",
      time: a.noHistory ? "—" : relTime(d),
      title,
      meta: a.noHistory
        ? `${a.make} ${a.model} — adaugă ultima revizie din pagina Flotă`
        : `${a.make} ${a.model}`,
      tag: a.noHistory ? "LIPSĂ ISTORIC" : d < 0 ? "CRITIC" : "ÎN CURÂND",
      tone: d < 0 && !a.noHistory ? "danger" : "warn",
      action: isService ? "VEZI FLOTA" : `PROGRAMEAZĂ ${TYPE_LABEL[a.alertType].toUpperCase()}`,
      actionPrimary: !isService && d < 0,
      href: "/fleet",
      priority: a.noHistory ? 3 : d < 0 ? 1 : 3,
      // Stable ref for the no-history case (expiresAt would shift every call
      // and self-invalidate any snooze).
      conditionRef: a.noHistory ? "service:none" : `${a.alertType}:${a.expiresAt}`,
      vehicleId: a.id,
      vehiclePlate: a.licensePlate,
      fleetAlertType: a.alertType,
    });
  }

  // Task-uri proiect + pași de workflow cu termen apropiat (depășite + ≤7 zile).
  // Pașii de workflow (source "workflow_step", ex. „Depune cerere aviz") apar
  // în aceeași categorie „Task-uri" ca task-urile ad-hoc.
  for (const t of [...deadlines.overdue, ...deadlines.urgent, ...deadlines.upcoming]) {
    const overdue = t.daysRemaining < 0;
    const urgent = t.priority === "urgent" || (t.daysRemaining >= 0 && t.daysRemaining <= w.deadlineUrgentDays);
    items.push({
      id: t.id,
      kind: "task",
      time: relTime(t.daysRemaining),
      title: t.title,
      meta: t.projectName ?? "",
      tag: overdue ? "OVERDUE" : urgent ? "URGENT" : "TERMEN",
      tone: overdue || urgent ? "danger" : "warn",
      action: "DESCHIDE",
      href: t.projectId ? `/projects/${t.projectId}` : null,
      priority: overdue ? 1 : urgent ? 2 : 3,
      conditionRef: `${t.status ?? ""}:${t.dueAt}`,
    });
  }

  // Proiecte cu deadline
  for (const p of projectDeadlines) {
    if (!p.scheduledDate) continue;
    const d = Math.ceil((p.scheduledDate.getTime() - now.getTime()) / (24 * 3600_000));
    const clientName = p.client.companyName || `${p.client.firstName ?? ""} ${p.client.lastName ?? ""}`.trim();
    items.push({
      id: `project-${p.id}`,
      kind: "project",
      time: relTime(d),
      title: p.name,
      meta: [p.projectType?.name, clientName].filter(Boolean).join(" · "),
      status: p.status,
      tag: "DEADLINE",
      tone: d < 0 ? "danger" : "warn",
      action: "VEZI PROIECT",
      href: `/projects/${p.id}`,
      priority: d < 0 ? 1 : 3,
      conditionRef: `${p.status}:${p.scheduledDate.toISOString()}`,
    });
  }

  // Apply tenant-wide snooze/dismiss overlay (self-invalidating via conditionRef).
  // Any operator's snooze hides the item from everyone in the firm — by design.
  const states = await fastify.prisma.actionFeedState.findMany({
    where: { tenantId, actionKey: { in: items.map((i) => i.id) } },
  });
  const stateByKey = new Map(states.map((st) => [st.actionKey, st]));

  // Pre-load the tenant audit log for every currently-snoozed item so the UI
  // can render the inline history under each one. History is tenant-scoped
  // per UX decision (2026-06-25).
  const snoozedKeys = states
    .filter((st) => st.snoozedUntil && st.snoozedUntil > now)
    .map((st) => st.actionKey);
  const historyByKey = new Map<string, ActionItem["history"]>();
  if (snoozedKeys.length > 0) {
    const notes = await fastify.prisma.actionFeedSnoozeNote.findMany({
      where: { tenantId, actionKey: { in: snoozedKeys } },
      orderBy: { createdAt: "desc" },
      take: snoozedKeys.length * 10, // cap; UI shows latest 5 anyway
    });
    for (const n of notes) {
      const arr = historyByKey.get(n.actionKey) ?? [];
      if (arr.length < 5) {
        arr.push({
          at: n.createdAt.toISOString(),
          until: n.until ? n.until.toISOString() : null,
          note: n.note,
          authorName: n.authorName,
          eventType: n.eventType,
        });
        historyByKey.set(n.actionKey, arr);
      }
    }
  }

  const visibleItems = items
    .map((item): ActionItem | null => {
      const st = stateByKey.get(item.id);
      // No state, or the underlying condition changed → show as active.
      if (!st || st.conditionRef !== item.conditionRef) return item;
      if (st.dismissedAt) return null; // acknowledged → hidden
      if (st.snoozedUntil && st.snoozedUntil > now) {
        return {
          ...item,
          snoozedUntil: st.snoozedUntil.toISOString(),
          reason: st.reason,
          snoozedById: st.snoozedById,
          snoozedByName: st.snoozedByName,
          history: historyByKey.get(item.id),
        };
      }
      return item; // snooze expired → active again
    })
    .filter((x): x is ActionItem => x !== null);

  // Active items first (by priority), snoozed items sink to the bottom.
  visibleItems.sort((a, b) => {
    const aSnoozed = a.snoozedUntil ? 1 : 0;
    const bSnoozed = b.snoozedUntil ? 1 : 0;
    if (aSnoozed !== bSnoozed) return aSnoozed - bSnoozed;
    return a.priority - b.priority;
  });

  const projectsDueSoon = projectDeadlines.filter(
    (p) => p.scheduledDate && p.scheduledDate.getTime() >= todayStart.getTime(),
  ).length;

  const summary = {
    fleet: {
      count: fleetByVehicle.size,
      plates: [...fleetByVehicle.values()].slice(0, 2).map((a) => a.licensePlate),
    },
    projects: { active: activeProjects, dueSoon: projectsDueSoon },
    revisions: {
      count: revisions.length,
      names: revisions.slice(0, 3).map((r) => r.clientName.split(" ").slice(-1)[0] || r.clientName),
    },
    tomorrow: {
      count: tomorrowAppts.length,
      firstAt: tomorrowAppts[0]?.date.toISOString() ?? null,
      lastAt: tomorrowAppts.at(-1)?.date.toISOString() ?? null,
    },
    today: {
      count: todayAppts.length,
      firstAt: todayAppts[0]?.date.toISOString() ?? null,
      lastAt: todayAppts.at(-1)?.date.toISOString() ?? null,
    },
  };

  return { items: visibleItems, summary };
}

/* ─── Action-feed snooze / dismiss (tenant-wide overlay) ──────────────────── */

interface SnoozeInput {
  actionKey: string;
  kind: string;
  conditionRef: string;
  until: string;
  reason?: string;
  note?: string;
}
interface DismissInput {
  actionKey: string;
  kind: string;
  conditionRef: string;
  reason?: string;
}
interface UnsnoozeInput {
  actionKey: string;
  note: string;
}

/** Opportunistic cleanup of long-expired snoozes (no cron needed). */
async function cleanupStaleStates(fastify: FastifyInstance, tenantId: string) {
  await fastify.prisma.actionFeedState
    .deleteMany({
      where: { tenantId, dismissedAt: null, snoozedUntil: { lt: addDays(new Date(), -30) } },
    })
    .catch(() => {});
}

/** Snapshot the operator's display name from User so the audit row survives
 *  user deletes/renames and the UI doesn't need a join on every read. */
async function resolveAuthorName(fastify: FastifyInstance, userId: string): Promise<string> {
  const author = await fastify.prisma.user.findUnique({
    where: { id: userId },
    select: { firstName: true, lastName: true, email: true },
  });
  if (!author) return "—";
  return [author.firstName, author.lastName].filter(Boolean).join(" ").trim() || author.email;
}

export async function snoozeAction(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string,
  input: SnoozeInput
) {
  await cleanupStaleStates(fastify, tenantId);
  const authorName = await resolveAuthorName(fastify, userId);
  const noteText = input.note ?? input.reason ?? null;

  const [state] = await fastify.prisma.$transaction([
    fastify.prisma.actionFeedState.upsert({
      where: { tenantId_actionKey: { tenantId, actionKey: input.actionKey } },
      create: {
        tenantId,
        actionKey: input.actionKey,
        kind: input.kind,
        conditionRef: input.conditionRef,
        snoozedUntil: new Date(input.until),
        reason: noteText,
        snoozedById: userId,
        snoozedByName: authorName,
      },
      update: {
        kind: input.kind,
        conditionRef: input.conditionRef,
        snoozedUntil: new Date(input.until),
        reason: noteText,
        dismissedAt: null,
        snoozedById: userId,
        snoozedByName: authorName,
      },
    }),
    fastify.prisma.actionFeedSnoozeNote.create({
      data: {
        tenantId,
        actionKey: input.actionKey,
        kind: input.kind,
        eventType: "snooze",
        until: new Date(input.until),
        note: noteText,
        authorId: userId,
        authorName,
      },
    }),
  ]);
  return state;
}

export async function dismissAction(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string,
  input: DismissInput
) {
  const authorName = await resolveAuthorName(fastify, userId);

  const [state] = await fastify.prisma.$transaction([
    fastify.prisma.actionFeedState.upsert({
      where: { tenantId_actionKey: { tenantId, actionKey: input.actionKey } },
      create: {
        tenantId,
        actionKey: input.actionKey,
        kind: input.kind,
        conditionRef: input.conditionRef,
        dismissedAt: new Date(),
        reason: input.reason ?? null,
        snoozedById: userId,
        snoozedByName: authorName,
      },
      update: {
        kind: input.kind,
        conditionRef: input.conditionRef,
        dismissedAt: new Date(),
        snoozedUntil: null,
        reason: input.reason ?? null,
        snoozedById: userId,
        snoozedByName: authorName,
      },
    }),
    fastify.prisma.actionFeedSnoozeNote.create({
      data: {
        tenantId,
        actionKey: input.actionKey,
        kind: input.kind,
        eventType: "dismiss",
        until: null,
        note: input.reason ?? null,
        authorId: userId,
        authorName,
      },
    }),
  ]);
  return state;
}

export async function unsnoozeAction(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string,
  input: UnsnoozeInput
) {
  const authorName = await resolveAuthorName(fastify, userId);
  // Read the existing state so we can capture which item-kind is being
  // reactivated in the audit row (no FK to actionKey otherwise).
  const existing = await fastify.prisma.actionFeedState.findUnique({
    where: { tenantId_actionKey: { tenantId, actionKey: input.actionKey } },
  });

  await fastify.prisma.$transaction([
    fastify.prisma.actionFeedState.deleteMany({
      where: { tenantId, actionKey: input.actionKey },
    }),
    fastify.prisma.actionFeedSnoozeNote.create({
      data: {
        tenantId,
        actionKey: input.actionKey,
        kind: existing?.kind ?? "unknown",
        eventType: "unsnooze",
        until: null,
        note: input.note,
        authorId: userId,
        authorName,
      },
    }),
  ]);
  return { success: true };
}

export async function getMyTasks(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string
) {
  const now = new Date();
  const tomorrowEnd = endOfDay(addDays(now, 1));

  return fastify.prisma.task.findMany({
    where: {
      tenantId,
      deletedAt: null,
      assignedUserId: userId,
      status: { in: ["open", "in_progress"] },
      OR: [
        { dueAt: null },
        { dueAt: { lte: tomorrowEnd } },
      ],
    },
    select: {
      id: true,
      title: true,
      description: true,
      priority: true,
      status: true,
      dueAt: true,
      project: { select: { id: true, name: true } },
    },
    orderBy: [
      { dueAt: { sort: "asc", nulls: "last" } },
      { priority: "desc" },
    ],
    take: 20,
  });
}
