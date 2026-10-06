import { Worker, Queue, type Job } from "bullmq";
import { PrismaClient } from "@prisma/client";
import { redisConnection } from "../config/redis.js";
import { dispatch } from "../modules/notifications/dispatch.js";
import { getTenantEventMap } from "../modules/notifications/tenant-settings.js";
import { env } from "../config/env.js";

/**
 * Scheduled scanner: once or twice a day it finds the activities due *today or
 * tomorrow* and pushes a notification to the responsible user(s) across their
 * enabled channels (in-app / email / web-push). Idempotent per run-day via the
 * dispatch dedupeKey, so re-runs and multi-channel fan-out never double-notify.
 */

const prisma = new PrismaClient();

const QUEUE_NAME = "notification-scanner";
// 07:00 (heads-up) and 13:00 (midday reminder), Europe/Bucharest.
const CRON_PATTERN = "0 7,13 * * *";

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function fmtRo(d: Date): string {
  return d.toLocaleDateString("ro-RO");
}
function fmtRoDateTime(d: Date): string {
  return d.toLocaleString("ro-RO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Scan a single tenant and dispatch all due-today/tomorrow notifications. */
async function scanTenant(tenantId: string, now: Date): Promise<number> {
  const todayStart = startOfDay(now);
  const tomorrowEnd = new Date(todayStart);
  tomorrowEnd.setDate(tomorrowEnd.getDate() + 2); // end of tomorrow (exclusive)
  const runDate = ymd(now);
  const tomorrowStart = new Date(todayStart.getTime() + 24 * 3600_000);
  let count = 0;

  // Tenant-level switches: which event types this firm emits at all.
  const enabled = await getTenantEventMap(prisma, tenantId);

  // Office staff (admins / managers) — recipients for tenant-wide items
  // (appointments, fleet) that aren't tied to a single assigned user.
  const officeStaff = await prisma.user.findMany({
    where: { tenantId, isActive: true, role: { in: ["ADMIN", "MANAGER"] } },
    select: { id: true },
  });

  // ── Tasks assigned to a user, due today or tomorrow ───────────────────────
  const tasks = !enabled.task_due ? [] : await prisma.task.findMany({
    where: {
      tenantId,
      deletedAt: null,
      status: { in: ["open", "in_progress", "overdue"] },
      assignedUserId: { not: null },
      dueAt: { gte: todayStart, lt: tomorrowEnd },
    },
    select: { id: true, title: true, dueAt: true, assignedUserId: true, projectId: true, clientId: true },
  });
  for (const t of tasks) {
    const due = t.dueAt!;
    const isToday = due < new Date(todayStart.getTime() + 24 * 3600_000);
    const res = await dispatch(prisma, tenantId, {
      userId: t.assignedUserId!,
      category: "tasks",
      subject: isToday ? `Activitate scadentă azi: ${t.title}` : `Activitate scadentă mâine: ${t.title}`,
      body: `Ai o activitate „${t.title}" cu termen ${fmtRo(due)}.`,
      url: t.projectId ? `/projects/${t.projectId}` : "/dashboard",
      dedupeKey: `due:task:${t.id}:${runDate}`,
      projectId: t.projectId,
      clientId: t.clientId,
      taskId: t.id,
    });
    if (!res.skipped) count++;
  }

  // ── Appointments scheduled today or tomorrow → office staff ───────────────
  const appts = !enabled.appointment_reminder ? [] : await prisma.appointment.findMany({
    where: {
      tenantId,
      deletedAt: null,
      status: { in: ["scheduled", "in_progress", "rescheduled"] },
      date: { gte: todayStart, lt: tomorrowEnd },
    },
    select: {
      id: true,
      title: true,
      date: true,
      clientId: true,
      client: { select: { firstName: true, lastName: true, companyName: true } },
      // Tehnicianul atribuit și contul lui — mementoul trebuie să ajungă la omul
      // care se duce la client, nu doar la birou.
      employee: { select: { firstName: true, lastName: true, userId: true } },
    },
    orderBy: { date: "asc" },
  });
  for (const a of appts) {
    const when = a.date < tomorrowStart ? "azi" : "mâine";
    const clientName = a.client
      ? a.client.companyName || [a.client.firstName, a.client.lastName].filter(Boolean).join(" ")
      : "";
    const techName = a.employee
      ? [a.employee.firstName, a.employee.lastName].filter(Boolean).join(" ")
      : "";
    const assignedUserId = a.employee?.userId ?? null;
    // Tehnicianul primește mementoul la persoana întâi; biroul primește aceeași
    // programare cu numele lui. `dispatch` dedublează pe (userId, dedupeKey),
    // deci destinatarul nou nu se ciocnește de rândurile existente.
    const recipients: { id: string; mine: boolean }[] = [
      ...(assignedUserId ? [{ id: assignedUserId, mine: true }] : []),
      ...officeStaff.filter((u) => u.id !== assignedUserId).map((u) => ({ id: u.id, mine: false })),
    ];
    for (const r of recipients) {
      const body = r.mine
        ? `Ai o programare ${when} la ${fmtRoDateTime(a.date)}${clientName ? ` — ${clientName}` : ""}.`
        : `Programare ${when} la ${fmtRoDateTime(a.date)}${clientName ? ` — ${clientName}` : ""}${techName ? ` (${techName})` : " (nerepartizată)"}.`;
      const res = await dispatch(prisma, tenantId, {
        userId: r.id,
        category: "tasks",
        subject: `Programare ${when}: ${a.title}`,
        body,
        url: "/calendar",
        dedupeKey: `due:appt:${a.id}:${runDate}`,
        clientId: a.clientId,
      });
      if (!res.skipped) count++;
    }
  }

  // ── Fleet ITP / RCA / rovinietă expiring today or tomorrow ────────────────
  const vehicles = !enabled.fleet_expiry ? [] : await prisma.vehicle.findMany({
    where: {
      tenantId,
      isActive: true,
      OR: [
        { itpExpiry: { gte: todayStart, lt: tomorrowEnd } },
        { insuranceExpiry: { gte: todayStart, lt: tomorrowEnd } },
        { vignetteExpiry: { gte: todayStart, lt: tomorrowEnd } },
      ],
    },
    select: { id: true, licensePlate: true, itpExpiry: true, insuranceExpiry: true, vignetteExpiry: true },
  });
  if (vehicles.length > 0) {
    const LABELS = { itp: "ITP", insurance: "RCA", vignette: "Rovinieta" } as const;
    for (const v of vehicles) {
      const checks: Array<{ date: Date | null; type: keyof typeof LABELS }> = [
        { date: v.itpExpiry, type: "itp" },
        { date: v.insuranceExpiry, type: "insurance" },
        { date: v.vignetteExpiry, type: "vignette" },
      ];
      for (const { date, type } of checks) {
        if (!date || date < todayStart || date >= tomorrowEnd) continue;
        for (const u of officeStaff) {
          const res = await dispatch(prisma, tenantId, {
            userId: u.id,
            category: "fleet",
            subject: `${LABELS[type]} expiră: ${v.licensePlate}`,
            body: `${LABELS[type]} pentru vehiculul ${v.licensePlate} expiră pe ${fmtRo(date)}. Programează din dashboard.`,
            url: "/fleet",
            dedupeKey: `due:fleet:${v.id}:${type}:${runDate}`,
            vehicleId: v.id,
          });
          if (!res.skipped) count++;
        }
      }
    }
  }

  return count;
}

async function scanAll(): Promise<void> {
  const now = new Date();
  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  let total = 0;
  for (const t of tenants) {
    try {
      total += await scanTenant(t.id, now);
    } catch (err) {
      console.error(`[notif-scanner] tenant ${t.id} failed:`, err);
    }
  }
  console.log(`[notif-scanner] dispatched ${total} notification(s) across ${tenants.length} tenant(s)`);
}

async function main() {
  // One-shot mode for manual testing: `tsx notification-scanner.worker.ts --now`
  if (process.argv.includes("--now")) {
    await scanAll();
    await prisma.$disconnect();
    process.exit(0);
  }

  if (!env.VAPID_PUBLIC_KEY) {
    console.warn("[notif-scanner] VAPID keys not set — web push disabled (email + in-app still work).");
  }

  const queue = new Queue(QUEUE_NAME, { connection: redisConnection });
  // Idempotent repeatable registration (same jobId replaces the schedule).
  await queue.add(
    "scan",
    {},
    { repeat: { pattern: CRON_PATTERN, tz: "Europe/Bucharest" }, jobId: "notif-scan-cron", removeOnComplete: true, removeOnFail: 50 },
  );

  const worker = new Worker(QUEUE_NAME, async (_job: Job) => scanAll(), {
    connection: redisConnection,
    concurrency: 1,
  });

  worker.on("failed", (_job, err) => console.error("[notif-scanner] run failed:", err.message));

  console.log(`[notif-scanner] started — schedule "${CRON_PATTERN}" (Europe/Bucharest)`);

  process.on("SIGTERM", async () => {
    await worker.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[notif-scanner] fatal:", err);
  process.exit(1);
});
