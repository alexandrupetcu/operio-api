import type { FastifyInstance } from "fastify";

const REVISION_INTERVAL_YEARS = 2; // ISCIR A1/2010
const REVISION_WARNING_DAYS = 45;
const FLEET_WARNING_DAYS = 30;
const DEADLINE_UPCOMING_DAYS = 7;

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
  userId: string
) {
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);

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
          { itpExpiry: { lte: addDays(now, FLEET_WARNING_DAYS) } },
          { insuranceExpiry: { lte: addDays(now, FLEET_WARNING_DAYS) } },
          { vignetteExpiry: { lte: addDays(now, FLEET_WARNING_DAYS) } },
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
  tenantId: string
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
  tenantId: string
) {
  const now = new Date();
  const upcomingCutoff = endOfDay(addDays(now, DEADLINE_UPCOMING_DAYS));

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
        project: { select: { id: true, name: true } },
      },
      orderBy: { dueAt: "asc" },
    }),
    fastify.prisma.workflowStepInstance.findMany({
      where: {
        tenantId,
        status: { in: ["pending", "active", "waiting"] },
        dueAt: { not: null, lte: upcomingCutoff },
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
    urgent: items.filter((i) => i.daysRemaining >= 0 && i.daysRemaining <= 3),
    upcoming: items.filter((i) => i.daysRemaining > 3 && i.daysRemaining <= 7),
  };
}

export async function getExpiringRevisions(
  fastify: FastifyInstance,
  tenantId: string
) {
  const now = new Date();
  const warningCutoff = addDays(now, REVISION_WARNING_DAYS);

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
      expiresAt.setFullYear(expiresAt.getFullYear() + REVISION_INTERVAL_YEARS);
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
  tenantId: string
) {
  const now = new Date();
  const warningCutoff = addDays(now, FLEET_WARNING_DAYS);

  const vehicles = await fastify.prisma.vehicle.findMany({
    where: {
      tenantId,
      isActive: true,
      OR: [
        { itpExpiry: { lte: warningCutoff } },
        { insuranceExpiry: { lte: warningCutoff } },
        { vignetteExpiry: { lte: warningCutoff } },
      ],
    },
    select: {
      id: true,
      licensePlate: true,
      make: true,
      model: true,
      itpExpiry: true,
      insuranceExpiry: true,
      vignetteExpiry: true,
    },
  });

  type VehicleAlert = {
    id: string;
    licensePlate: string;
    make: string;
    model: string;
    alertType: "itp" | "insurance" | "vignette";
    expiresAt: string;
    daysUntilExpiry: number;
  };

  const expired: VehicleAlert[] = [];
  const expiring: VehicleAlert[] = [];

  for (const v of vehicles) {
    const checks: Array<{ date: Date | null; type: "itp" | "insurance" | "vignette" }> = [
      { date: v.itpExpiry, type: "itp" },
      { date: v.insuranceExpiry, type: "insurance" },
      { date: v.vignetteExpiry, type: "vignette" },
    ];

    for (const { date, type } of checks) {
      if (!date || date > warningCutoff) continue;
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
  }

  expired.sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);
  expiring.sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);

  return { expired, expiring };
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
