import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { resolveEntitlements, serializeEntitlements } from "../../lib/entitlements/index.js";

/**
 * Vederea platformei pentru administratorul ei (MASTER_ADMIN): firmele, cât de
 * mult folosesc aplicația și starea cozilor. Toate numerele vin din câteva
 * `groupBy`/`count` pe toată baza — niciodată o interogare per firmă.
 */

const DAY = 24 * 3600_000;

/** Numărătorile unei firme, așa cum apar în lista de firme și în detaliu. */
export interface TenantCounts {
  users: number;
  mobileUsers: number;
  clients: number;
  projects: number;
  dossiers: number;
  appointmentsLast30d: number;
  documents: number;
}

const EMPTY_COUNTS: TenantCounts = { users: 0, mobileUsers: 0, clients: 0, projects: 0, dossiers: 0, appointmentsLast30d: 0, documents: 0 };

type CountRow = { tenantId: string | null; _count: { _all: number } };

function toMap(rows: CountRow[]): Map<string, number> {
  return new Map(rows.filter((r) => r.tenantId).map((r) => [r.tenantId as string, r._count._all]));
}

/**
 * Numărătorile pe firme (toate, sau doar `tenantIds`) + ultima activitate:
 * cea mai recentă programare modificată, document creat sau conectare (refresh
 * token) a unui utilizator al firmei.
 */
export async function tenantCountsAndActivity(
  fastify: FastifyInstance,
  tenantIds?: string[],
  now = new Date(),
): Promise<{ counts: Map<string, TenantCounts>; lastActivity: Map<string, Date> }> {
  const prisma = fastify.prisma;
  const since30 = new Date(now.getTime() - 30 * DAY);

  const [users, mobile, clients, projects, dossiers, appts, docs, apptLast, docLast, loginLast] = await Promise.all([
    prisma.user.groupBy({ by: ["tenantId"], where: { ...(tenantIds ? { tenantId: { in: tenantIds } } : { tenantId: { not: null } }) }, _count: { _all: true } }),
    prisma.user.groupBy({ by: ["tenantId"], where: { mobileAccess: true, isActive: true, ...(tenantIds ? { tenantId: { in: tenantIds } } : { tenantId: { not: null } }) }, _count: { _all: true } }),
    prisma.client.groupBy({ by: ["tenantId"], where: tenantIds ? { tenantId: { in: tenantIds } } : {}, _count: { _all: true } }),
    prisma.project.groupBy({ by: ["tenantId"], where: { kind: { not: "quick_dossier" }, ...(tenantIds ? { tenantId: { in: tenantIds } } : {}) }, _count: { _all: true } }),
    prisma.project.groupBy({ by: ["tenantId"], where: { kind: "quick_dossier", ...(tenantIds ? { tenantId: { in: tenantIds } } : {}) }, _count: { _all: true } }),
    prisma.appointment.groupBy({
      by: ["tenantId"],
      where: { deletedAt: null, date: { gte: since30, lte: now }, ...(tenantIds ? { tenantId: { in: tenantIds } } : {}) },
      _count: { _all: true },
    }),
    prisma.document.groupBy({ by: ["tenantId"], where: tenantIds ? { tenantId: { in: tenantIds } } : {}, _count: { _all: true } }),
    prisma.appointment.groupBy({ by: ["tenantId"], where: tenantIds ? { tenantId: { in: tenantIds } } : {}, _max: { updatedAt: true } }),
    prisma.document.groupBy({ by: ["tenantId"], where: tenantIds ? { tenantId: { in: tenantIds } } : {}, _max: { createdAt: true } }),
    // Refresh token-ul nu are tenantId — trecem prin utilizator, într-o singură interogare.
    prisma.$queryRaw<{ tenantId: string; last: Date | null }[]>`
      SELECT u."tenantId" AS "tenantId", max(rt."createdAt") AS "last"
      FROM "RefreshToken" rt JOIN "User" u ON u.id = rt."userId"
      WHERE u."tenantId" IS NOT NULL
      GROUP BY u."tenantId"`,
  ]);

  const maps = {
    users: toMap(users as CountRow[]),
    mobileUsers: toMap(mobile as CountRow[]),
    clients: toMap(clients as CountRow[]),
    projects: toMap(projects as CountRow[]),
    dossiers: toMap(dossiers as CountRow[]),
    appointmentsLast30d: toMap(appts as CountRow[]),
    documents: toMap(docs as CountRow[]),
  };
  const ids = new Set<string>(tenantIds ?? []);
  for (const m of Object.values(maps)) for (const k of m.keys()) ids.add(k);

  const counts = new Map<string, TenantCounts>();
  for (const id of ids) {
    counts.set(id, {
      users: maps.users.get(id) ?? 0,
      mobileUsers: maps.mobileUsers.get(id) ?? 0,
      clients: maps.clients.get(id) ?? 0,
      projects: maps.projects.get(id) ?? 0,
      dossiers: maps.dossiers.get(id) ?? 0,
      appointmentsLast30d: maps.appointmentsLast30d.get(id) ?? 0,
      documents: maps.documents.get(id) ?? 0,
    });
  }

  const lastActivity = new Map<string, Date>();
  const bump = (id: string | null, d: Date | null | undefined) => {
    if (!id || !d) return;
    const prev = lastActivity.get(id);
    if (!prev || d > prev) lastActivity.set(id, d);
  };
  for (const r of apptLast) bump(r.tenantId, r._max.updatedAt);
  for (const r of docLast) bump(r.tenantId, r._max.createdAt);
  for (const r of loginLast) {
    if (tenantIds && !tenantIds.includes(r.tenantId)) continue;
    bump(r.tenantId, r.last ? new Date(r.last) : null);
  }
  return { counts, lastActivity };
}

export function countsFor(map: Map<string, TenantCounts>, id: string): TenantCounts {
  return map.get(id) ?? { ...EMPTY_COUNTS };
}

/** Forma cozilor din `GET /admin/queue-stats`; zero când Redis nu răspunde. */
export interface QueueStats {
  documentGeneration: Record<string, number>;
  workflowEngine: Record<string, number>;
}
const EMPTY_QUEUE = { active: 0, waiting: 0, completed: 0, failed: 0, delayed: 0 };

/** Panoul principal al platformei. `queueStats` vine din admin.service (BullMQ). */
export async function overview(fastify: FastifyInstance, queueStats: () => Promise<QueueStats>, now = new Date()) {
  const prisma = fastify.prisma;
  const since7 = new Date(now.getTime() - 7 * DAY);
  const since30 = new Date(now.getTime() - 30 * DAY);
  const in14 = new Date(now.getTime() + 14 * DAY);
  const tenantUser: Prisma.UserWhereInput = { tenantId: { not: null } };

  const [tenants, usersTotal, usersActive, mobileSeats, appts7, reports7, docs7, failed7, dossiers, projects, queues, activity] = await Promise.all([
    prisma.tenant.findMany({ select: { id: true, name: true, plan: true, planUntil: true, createdAt: true } }),
    prisma.user.count({ where: tenantUser }),
    prisma.user.count({ where: { ...tenantUser, isActive: true } }),
    prisma.user.count({ where: { ...tenantUser, isActive: true, mobileAccess: true } }),
    prisma.appointment.count({ where: { deletedAt: null, date: { gte: since7, lte: now } } }),
    prisma.appointment.count({ where: { deletedAt: null, status: "completed", completedAt: { gte: since7 } } }),
    prisma.document.count({ where: { createdAt: { gte: since7 }, status: { in: ["COMPLETED", "UPLOADED", "SIGNING", "SIGNED"] } } }),
    prisma.document.count({ where: { createdAt: { gte: since7 }, status: "FAILED" } }),
    prisma.project.count({ where: { kind: "quick_dossier" } }),
    prisma.project.count({ where: { kind: { not: "quick_dossier" } } }),
    queueStats().catch(() => ({ documentGeneration: { ...EMPTY_QUEUE }, workflowEngine: { ...EMPTY_QUEUE } })),
    prisma.appointment.groupBy({ by: ["tenantId"], where: { deletedAt: null, date: { gte: since30, lte: now } }, _count: { _all: true } }),
  ]);

  // Firmă „fără plan” = abonament expirat (planUntil în trecut); altfel planul ei.
  const byPlan = { field: 0, execution: 0, none: 0 };
  for (const t of tenants) {
    if (t.planUntil && t.planUntil < now) byPlan.none++;
    else if (t.plan === "field") byPlan.field++;
    else if (t.plan === "execution") byPlan.execution++;
    else byPlan.none++;
  }
  const names = new Map(tenants.map((t) => [t.id, t.name]));

  return {
    tenants: {
      total: tenants.length,
      byPlan,
      newLast30d: tenants.filter((t) => t.createdAt >= since30).length,
      expiringIn14d: tenants
        .filter((t) => t.planUntil && t.planUntil >= now && t.planUntil <= in14)
        .sort((a, b) => (a.planUntil as Date).getTime() - (b.planUntil as Date).getTime())
        .map((t) => ({ id: t.id, name: t.name, planUntil: (t.planUntil as Date).toISOString() })),
    },
    users: { total: usersTotal, active: usersActive, mobileSeats },
    activity: {
      appointmentsLast7d: appts7,
      reportsCompletedLast7d: reports7,
      documentsGeneratedLast7d: docs7,
      documentsFailedLast7d: failed7,
      dossiersTotal: dossiers,
      projectsTotal: projects,
    },
    queues,
    recentTenants: [...tenants]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 5)
      .map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt.toISOString(), plan: t.plan })),
    mostActive: activity
      .map((r) => ({ id: r.tenantId, name: names.get(r.tenantId) ?? "", appointmentsLast30d: r._count._all }))
      .sort((a, b) => b.appointmentsLast30d - a.appointmentsLast30d)
      .slice(0, 5),
  };
}

/** Detaliul unei firme pentru administratorul platformei. 404 pentru un id necunoscut. */
export async function tenantDetail(fastify: FastifyInstance, id: string) {
  const tenant = await fastify.prisma.tenant.findUnique({
    where: { id },
    select: { id: true, name: true, slug: true, subdomain: true, cui: true, plan: true, planUntil: true, entitlementOverrides: true, createdAt: true },
  });
  if (!tenant) throw fastify.httpErrors.notFound("Firma nu există");

  const [users, { counts }] = await Promise.all([
    fastify.prisma.user.findMany({
      where: { tenantId: id },
      select: {
        id: true, email: true, firstName: true, lastName: true, role: true, isActive: true, mobileAccess: true,
        employee: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: [{ role: "asc" }, { lastName: "asc" }],
    }),
    tenantCountsAndActivity(fastify, [id]),
  ]);
  const logins = users.length
    ? await fastify.prisma.refreshToken.groupBy({ by: ["userId"], where: { userId: { in: users.map((u) => u.id) } }, _max: { createdAt: true } })
    : [];
  const lastLogin = new Map(logins.map((l) => [l.userId, l._max.createdAt]));

  const { entitlementOverrides: _overrides, ...rest } = tenant;
  return {
    ...rest,
    planUntil: tenant.planUntil ? tenant.planUntil.toISOString() : null,
    createdAt: tenant.createdAt.toISOString(),
    entitlements: serializeEntitlements(resolveEntitlements(tenant)),
    counts: countsFor(counts, id),
    users: users.map((u) => ({ ...u, lastLoginAt: lastLogin.get(u.id)?.toISOString() ?? null })),
  };
}
