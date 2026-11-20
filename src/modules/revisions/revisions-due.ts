import type { FastifyInstance } from "fastify";
import { getExpiringRevisions } from "../dashboard/dashboard.service.js";
import { getAlertWindows } from "../tenant/alert-settings.js";
import { NO_REPORT_OUTCOMES } from "../appointments/appointments.service.js";
import { INSTALATIE_APPT_TYPES } from "../appointments/os-registration.js";

/**
 * Revizii → „Scadente”: ce trebuie programat în următoarele `days` zile (și ce a trecut
 * deja de scadență), fără ce e deja programat.
 * - centrale: ultima revizie + intervalul firmei (`getExpiringRevisions`, ca în panou);
 * - instalații: data următoarei lucrări scrisă în ultimul raport (`nextDate`), altfel
 *   +2 ani la verificare / +10 ani la revizie, de la finalizare.
 */
export interface DueRevision {
  key: string;
  kind: "centrala" | "instalatie";
  type: "revizie" | "revizie_instalatie" | "verificare_instalatie";
  clientId: string;
  clientName: string;
  clientPhone: string | null;
  subject: string | null;
  equipmentId: string | null;
  installationId: string | null;
  lastDate: string;
  dueDate: string;
  /** Zile până la scadență (negativ = depășită). */
  days: number;
}

const DAY = 86_400_000;
const daysFrom = (d: Date, now: Date) => Math.ceil((d.getTime() - now.getTime()) / DAY);

/** „15.10.2028” / „2028-10-15” → Date; altfel null. */
function parseDate(v: unknown): Date | null {
  const s = typeof v === "string" ? v.trim() : "";
  let m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

export async function dueRevisions(fastify: FastifyInstance, tenantId: string, days: number): Promise<DueRevision[]> {
  const now = new Date();
  const w = await getAlertWindows(fastify.prisma, tenantId);
  const centrale = await getExpiringRevisions(fastify, tenantId, { ...w, revisionWarningDays: days });
  const out: DueRevision[] = centrale.map((c) => ({
    key: `eq:${c.equipmentId}`,
    kind: "centrala",
    type: "revizie",
    clientId: c.clientId,
    clientName: c.clientName,
    clientPhone: c.clientPhone ?? null,
    subject: c.equipmentName,
    equipmentId: c.equipmentId,
    installationId: null,
    lastDate: c.lastRevisionDate,
    dueDate: c.expiresAt,
    days: c.daysUntilExpiry,
  }));

  // Instalațiile: ultima lucrare finalizată cu raport, pe fiecare instalație.
  const done = await fastify.prisma.appointment.findMany({
    where: {
      tenantId,
      deletedAt: null,
      status: "completed",
      type: { in: [...INSTALATIE_APPT_TYPES] },
      installationId: { not: null },
      OR: [{ completionOutcome: null }, { completionOutcome: { notIn: [...NO_REPORT_OUTCOMES] } }],
    },
    select: {
      type: true,
      completedAt: true,
      date: true,
      completionDataJson: true,
      installation: {
        select: {
          id: true,
          label: true,
          codTehnicPOD: true,
          appointments: { where: { deletedAt: null, status: { in: ["scheduled", "in_progress", "awaiting_report"] } }, select: { id: true }, take: 1 },
        },
      },
      client: { select: { id: true, companyName: true, firstName: true, lastName: true, phone: true } },
    },
    orderBy: { completedAt: "desc" },
  });
  const seen = new Set<string>();
  for (const a of done) {
    const inst = a.installation;
    if (!inst || !a.client || seen.has(inst.id)) continue;
    seen.add(inst.id);
    if (inst.appointments.length) continue; // deja programată
    const last = a.completedAt ?? a.date;
    const json = (a.completionDataJson ?? {}) as Record<string, unknown>;
    let due = parseDate(json.nextDate);
    if (!due) {
      due = new Date(last);
      due.setFullYear(due.getFullYear() + (a.type === "revizie_instalatie" ? 10 : 2));
    }
    const d = daysFrom(due, now);
    if (d > days) continue;
    out.push({
      key: `inst:${inst.id}`,
      kind: "instalatie",
      type: a.type as DueRevision["type"],
      clientId: a.client.id,
      clientName: a.client.companyName || [a.client.firstName, a.client.lastName].filter(Boolean).join(" ") || "—",
      clientPhone: a.client.phone,
      subject: inst.label || inst.codTehnicPOD || null,
      equipmentId: null,
      installationId: inst.id,
      lastDate: last.toISOString(),
      dueDate: due.toISOString(),
      days: d,
    });
  }
  return out.sort((x, y) => x.days - y.days);
}
