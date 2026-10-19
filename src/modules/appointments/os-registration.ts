import type { FastifyInstance } from "fastify";
import { Prisma, type PrismaClient } from "@prisma/client";
import { daysUntil, osRegistrationDeadline } from "../../lib/working-days.js";
import { getAlertWindows } from "../tenant/alert-settings.js";
import { osFeedState } from "./os-feed-state.js";

export { osFeedState };
import { getTenantEventMap } from "../notifications/tenant-settings.js";
import { dispatch } from "../notifications/dispatch.js";
import { regenerateFisaForOsRegistration } from "./appointments.service.js";
import { invalidateDashboardCache } from "../../lib/dashboard-cache.js";
import type { OsRegistrationInput } from "./appointments.schema.js";
import { getSampleClientId, excludeSampleAppointments } from "../tenant/sample-settings.js";

/** Tipurile de programare care produc o Fișă de evidență ce trebuie înregistrată la OS. */
export const INSTALATIE_APPT_TYPES = ["revizie_instalatie", "verificare_instalatie"] as const;

export const WORK_LABEL: Record<string, string> = {
  revizie_instalatie: "revizie tehnică",
  verificare_instalatie: "verificare tehnică",
};

export function clientDisplayName(c: { companyName: string | null; firstName: string | null; lastName: string | null } | null): string {
  if (!c) return "—";
  return c.companyName || [c.firstName, c.lastName].filter(Boolean).join(" ") || "—";
}

/**
 * Setează (sau șterge, cu `number: null`) numărul de înregistrare primit de la OS.
 * La setare, fișa (RT/FISA) se regenerează cu numărul tipărit în caseta „Înregistrare
 * la OS”, iar worker-ul trimite clientului exemplarul lui (art. 9 alin. 7) dacă are
 * e-mail și `notifyClient` nu e dezactivat. Trimiterea e asincronă — `osClientNotifiedAt`
 * se completează după randarea PDF-ului.
 */
export async function setOsRegistration(
  fastify: FastifyInstance,
  tenantId: string,
  appointmentId: string,
  input: OsRegistrationInput,
) {
  const appt = await fastify.prisma.appointment.findFirst({
    where: { id: appointmentId, tenantId, deletedAt: null },
    include: { client: { select: { id: true, email: true } } },
  });
  if (!appt) throw fastify.httpErrors.notFound("Programarea nu există");
  if (!(INSTALATIE_APPT_TYPES as readonly string[]).includes(appt.type)) {
    throw fastify.httpErrors.badRequest("Doar reviziile și verificările de instalație se înregistrează la OS");
  }
  if (appt.status !== "completed") {
    throw fastify.httpErrors.badRequest("Fișa se înregistrează după finalizarea vizitei");
  }

  // Ștergere (număr introdus greșit) — păstrăm istoricul notificării, nu-l mai retrimitem.
  if (!input.number) {
    const cleared = await fastify.prisma.appointment.update({
      where: { id: appointmentId },
      data: { osRegistrationNumber: null, osRegisteredAt: null },
      select: osSelect,
    });
    await invalidateDashboardCache(tenantId); // fișa reapare în „de înregistrat”
    return cleared;
  }

  const registeredAt = input.registeredAt ? new Date(input.registeredAt) : new Date();
  const updated = await fastify.prisma.appointment.update({
    where: { id: appointmentId },
    data: { osRegistrationNumber: input.number, osRegisteredAt: registeredAt },
    select: osSelect,
  });
  await invalidateDashboardCache(tenantId);

  const clientEmail = appt.client?.email ?? null;
  const willNotify = !!clientEmail && input.notifyClient !== false;
  const { queued } = await regenerateFisaForOsRegistration(fastify, tenantId, appointmentId, willNotify);

  return { ...updated, regenerationQueued: queued, willNotify: queued && willNotify, clientEmail };
}

const osSelect = {
  id: true,
  status: true,
  completedAt: true,
  osRegistrationNumber: true,
  osRegisteredAt: true,
  osClientNotifiedAt: true,
} satisfies Prisma.AppointmentSelect;

/**
 * Fișe finalizate, încă neînregistrate la OS — pentru panou și notificarea zilnică.
 * Întoarce și termenul: `workingDays` zile lucrătoare de la finalizare (setarea firmei,
 * implicit 5 — Ord. ANRE 179/2015).
 */
export async function listPendingOsRegistrations(db: PrismaClient, tenantId: string, workingDays: number) {
  // Fișa clientului de exemplu (onboarding) nu se înregistrează nicăieri.
  const sampleClientId = await getSampleClientId(db, tenantId);
  const rows = await db.appointment.findMany({
    where: {
      tenantId,
      deletedAt: null,
      status: "completed",
      type: { in: [...INSTALATIE_APPT_TYPES] },
      osRegistrationNumber: null,
      ...excludeSampleAppointments(sampleClientId),
    },
    select: {
      id: true,
      type: true,
      date: true,
      completedAt: true,
      updatedAt: true,
      client: { select: { id: true, companyName: true, firstName: true, lastName: true, phone: true } },
      clientAddress: { select: { address: true } },
      installation: { select: { distributorName: true } },
    },
    orderBy: { completedAt: "asc" },
    take: 100,
  });
  return rows.map((r) => {
    const completedAt = r.completedAt ?? r.updatedAt;
    return { ...r, completedAt, deadline: osRegistrationDeadline(completedAt, workingDays) };
  });
}

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : n < 20 ? `${n} ${many}` : `${n} de ${many}`);

function deadlineText(d: number, deadline: Date): string {
  if (d < 0) return `termen depășit de ${plural(-d, "zi", "zile")} (${deadline.toLocaleDateString("ro-RO")})`;
  if (d === 0) return "termen azi";
  if (d === 1) return "termen mâine";
  return `termen ${deadline.toLocaleDateString("ro-RO")} (${plural(d, "zi", "zile")})`;
}

/**
 * Rezumatul zilnic (scanerul de notificări, 07:00) către admini și manageri: fișele
 * neînregistrate la OS care au intrat în pragul urgent sau au depășit termenul.
 * Un singur mesaj pe zi și utilizator (`due:os:<zi>` — rularea de la 13:00 nu-l
 * repetă). Întoarce câte notificări au plecat.
 */
export async function sendOsRegistrationDigest(db: PrismaClient, tenantId: string, now = new Date()): Promise<number> {
  const enabled = await getTenantEventMap(db, tenantId);
  if (!enabled.os_registration_due) return 0;

  const w = await getAlertWindows(db, tenantId);
  const pending = await listPendingOsRegistrations(db, tenantId, w.osRegistrationWorkingDays);
  const due = pending
    .map((p) => ({ ...p, d: daysUntil(p.deadline, now) }))
    .filter((p) => osFeedState(p.d, w).urgent)
    .sort((a, b) => a.d - b.d);
  if (due.length === 0) return 0;

  const overdue = due.filter((p) => p.d < 0).length;
  const subject = `${plural(due.length, "fișă", "fișe")} de înregistrat la OS${overdue ? ` — ${overdue} cu termenul depășit` : ""}`;
  const MAX_LINES = 10;
  const lines = due.slice(0, MAX_LINES).map((p) => {
    const os = p.installation?.distributorName || "OS";
    return `• ${clientDisplayName(p.client)} — ${WORK_LABEL[p.type] ?? p.type}, ${os}: ${deadlineText(p.d, p.deadline)}`;
  });
  if (due.length > MAX_LINES) lines.push(`… și încă ${due.length - MAX_LINES}. Lista completă e în panoul principal.`);
  const body = `${lines.join("\n")}\n\nNumărul de înregistrare se completează din fișa clientului (Instalații → Înreg. OS).`;

  const recipients = await db.user.findMany({
    where: { tenantId, isActive: true, role: { in: ["ADMIN", "MANAGER"] } },
    select: { id: true },
  });
  const runDate = now.toISOString().slice(0, 10);
  let sent = 0;
  for (const u of recipients) {
    const res = await dispatch(db, tenantId, {
      userId: u.id,
      category: "tasks",
      subject,
      body,
      url: "/",
      dedupeKey: `due:os:${runDate}`,
    });
    if (!res.skipped) sent++;
  }
  return sent;
}
