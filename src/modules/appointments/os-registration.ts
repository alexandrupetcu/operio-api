import type { FastifyInstance } from "fastify";
import { Prisma, type PrismaClient } from "@prisma/client";
import { daysUntil, osRegistrationDeadline } from "../../lib/working-days.js";
import { getAlertWindows } from "../tenant/alert-settings.js";
import { osFeedState } from "./os-feed-state.js";

export { osFeedState };
import { getTenantEventMap } from "../notifications/tenant-settings.js";
import { dispatch } from "../notifications/dispatch.js";
import { NO_REPORT_OUTCOMES, isNoReportOutcome, regenerateFisaForOsRegistration, regenerateIscirForOsRegistration } from "./appointments.service.js";
import { invalidateDashboardCache } from "../../lib/dashboard-cache.js";
import type { OsRegistrationInput, OsSubmissionInput } from "./appointments.schema.js";
import { getSampleClientId, excludeSampleAppointments } from "../tenant/sample-settings.js";

/** Tipurile de programare care produc o Fișă de evidență ce trebuie înregistrată la OS. */
export const INSTALATIE_APPT_TYPES = ["revizie_instalatie", "verificare_instalatie"] as const;

/**
 * Tot ce se înregistrează la distribuitor (OS) după finalizare: fișele de instalație
 * și raportul ISCIR al reviziei de centrală. Anexa 6 ANRE rămâne doar pe instalații.
 */
export const OS_REGISTRATION_TYPES = ["revizie", ...INSTALATIE_APPT_TYPES] as const;

export const WORK_LABEL: Record<string, string> = {
  revizie: "revizie centrală (ISCIR)",
  revizie_instalatie: "revizie tehnică",
  verificare_instalatie: "verificare tehnică",
};

/** Doar vizitele cu raport se depun la OS („revenire” / „programare nouă” n-au ce depune). */
export const HAS_REPORT_WHERE = {
  OR: [{ completionOutcome: null }, { completionOutcome: { notIn: [...NO_REPORT_OUTCOMES] } }],
} satisfies Prisma.AppointmentWhereInput;

const NO_REPORT_MESSAGE = "Vizita a fost închisă fără raport (revenire / programare nouă) — completează întâi raportul";

/**
 * Restul documentelor vizitei (PV, buletin, contract), gata generate, care pleacă la
 * client împreună cu fișa / raportul înregistrat la OS — înainte de număr nu primește nimic.
 */
export async function osRegistrationAttachments(db: PrismaClient, tenantId: string, appointmentId: string, excludeDocumentId: string) {
  return db.document.findMany({
    where: { tenantId, appointmentId, status: "COMPLETED", s3Key: { endsWith: ".pdf" }, id: { not: excludeDocumentId } },
    select: { id: true, name: true, s3Key: true },
    orderBy: { createdAt: "asc" },
  });
}

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
  if (!(OS_REGISTRATION_TYPES as readonly string[]).includes(appt.type)) {
    throw fastify.httpErrors.badRequest("Doar reviziile de centrală și reviziile / verificările de instalație se înregistrează la OS");
  }
  if (appt.status !== "completed") {
    throw fastify.httpErrors.badRequest("Fișa se înregistrează după finalizarea vizitei");
  }
  if (isNoReportOutcome(appt.completionOutcome)) throw fastify.httpErrors.badRequest(NO_REPORT_MESSAGE);

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
    data: {
      osRegistrationNumber: input.number,
      osRegisteredAt: registeredAt,
      // Un număr de la OS înseamnă că raportul a fost depus (chiar dacă pasul n-a fost marcat).
      ...(!appt.osSubmittedAt && { osSubmittedAt: registeredAt }),
    },
    select: osSelect,
  });
  await invalidateDashboardCache(tenantId);

  const clientEmail = appt.client?.email ?? null;
  const willNotify = !!clientEmail && input.notifyClient !== false;
  // Revizia de centrală: raportul ISCIR; instalația: fișa RT/FISA.
  const { queued } =
    appt.type === "revizie"
      ? await regenerateIscirForOsRegistration(fastify, tenantId, appointmentId, willNotify)
      : await regenerateFisaForOsRegistration(fastify, tenantId, appointmentId, willNotify);

  return { ...updated, regenerationQueued: queued, willNotify: queued && willNotify, clientEmail };
}

/**
 * Pasul intermediar: raportul / fișa a fost depus(ă) la OS și se așteaptă validarea
 * (numărul vine ulterior, prin `setOsRegistration`). `submittedAt: null` anulează o
 * marcare greșită — doar cât timp nu există încă număr.
 */
export async function setOsSubmission(
  fastify: FastifyInstance,
  tenantId: string,
  appointmentId: string,
  input: OsSubmissionInput,
) {
  const appt = await fastify.prisma.appointment.findFirst({
    where: { id: appointmentId, tenantId, deletedAt: null },
    select: { id: true, type: true, status: true, completionOutcome: true, osRegistrationNumber: true },
  });
  if (!appt) throw fastify.httpErrors.notFound("Programarea nu există");
  if (!(OS_REGISTRATION_TYPES as readonly string[]).includes(appt.type)) {
    throw fastify.httpErrors.badRequest("Doar reviziile de centrală și reviziile / verificările de instalație se depun la OS");
  }
  if (appt.status !== "completed") throw fastify.httpErrors.badRequest("Se depune după finalizarea vizitei");
  if (isNoReportOutcome(appt.completionOutcome)) throw fastify.httpErrors.badRequest(NO_REPORT_MESSAGE);
  if (input.submittedAt === null && appt.osRegistrationNumber) {
    throw fastify.httpErrors.badRequest("Are deja număr de la OS — șterge întâi numărul");
  }
  const updated = await fastify.prisma.appointment.update({
    where: { id: appointmentId },
    data: { osSubmittedAt: input.submittedAt ? new Date(input.submittedAt) : null },
    select: osSelect,
  });
  await invalidateDashboardCache(tenantId);
  return updated;
}

const osSelect = {
  id: true,
  status: true,
  completedAt: true,
  osSubmittedAt: true,
  osRegistrationNumber: true,
  osRegisteredAt: true,
  osClientNotifiedAt: true,
} satisfies Prisma.AppointmentSelect;

/**
 * Fișe finalizate, încă neînregistrate la OS — pentru panou și notificarea zilnică.
 * Întoarce și termenul: `workingDays` zile lucrătoare de la finalizare (setarea firmei,
 * implicit 5 — Ord. ANRE 179/2015).
 */
export async function listPendingOsRegistrations(
  db: PrismaClient,
  tenantId: string,
  workingDays: number,
  /** Și fișele clientului de exemplu (panoul principal le arată marcate „Exemplu”; e-mailul și exporturile nu). */
  { includeSample = false }: { includeSample?: boolean } = {},
) {
  // Fișa clientului de exemplu (onboarding) nu se înregistrează nicăieri: nu intră în
  // rezumatul zilnic și în exporturi; pe panou apare doar ca să arate fluxul.
  const sampleClientId = await getSampleClientId(db, tenantId);
  const rows = await db.appointment.findMany({
    where: {
      tenantId,
      deletedAt: null,
      status: "completed",
      type: { in: [...OS_REGISTRATION_TYPES] },
      osRegistrationNumber: null,
      AND: [HAS_REPORT_WHERE, includeSample ? {} : excludeSampleAppointments(sampleClientId)],
    },
    select: {
      id: true,
      type: true,
      date: true,
      completedAt: true,
      updatedAt: true,
      osSubmittedAt: true,
      client: { select: { id: true, companyName: true, firstName: true, lastName: true, phone: true } },
      clientAddress: { select: { address: true } },
      installation: { select: { distributorName: true } },
    },
    orderBy: { completedAt: "asc" },
    take: 100,
  });
  return rows.map((r) => {
    const completedAt = r.completedAt ?? r.updatedAt;
    return {
      ...r,
      completedAt,
      deadline: osRegistrationDeadline(completedAt, workingDays),
      sample: !!sampleClientId && r.client?.id === sampleClientId,
    };
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
    // Ce e deja depus așteaptă răspunsul OS — nu mai e de făcut nimic urgent.
    .filter((p) => !p.osSubmittedAt && osFeedState(p.d, w).urgent)
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
