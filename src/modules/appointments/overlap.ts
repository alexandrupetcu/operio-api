/**
 * Detectarea suprapunerilor pe același tehnician.
 *
 * Este strict un avertisment: realitatea din teren bate regula, iar un dispecer
 * trebuie să poată suprapune deliberat. Verificarea rulează *după* scriere și
 * eșecul ei nu poate împiedica salvarea.
 *
 * Prisma nu poate calcula `date + duration` în `where`, așa că se caută într-o
 * fereastră mărginită de durata maximă admisă (indexul [tenantId, employeeId,
 * date]) și se filtrează în JS. Intervalele sunt semi-deschise: 09:00–10:00 și
 * 10:00–11:00 nu se suprapun.
 */
import type { FastifyInstance } from "fastify";

/** Plafonul din schema de validare — cât de departe în urmă poate începe o programare care încă durează. */
export const MAX_APPOINTMENT_MINUTES = 480;

/** Programările terminate sau anulate nu mai ocupă intervalul. */
const BUSY_STATUS = ["scheduled", "in_progress", "awaiting_report", "rescheduled"];

export function apptEnd(start: Date, duration: number | null, defaultMinutes: number): Date {
  return new Date(start.getTime() + (duration ?? defaultMinutes) * 60_000);
}

export interface OverlapHit {
  id: string;
  title: string;
  from: string;
  to: string;
}

export interface OverlapResult {
  hasOverlap: boolean;
  count: number;
  items: OverlapHit[];
}

export const NO_OVERLAP: OverlapResult = { hasOverlap: false, count: 0, items: [] };

export async function findOverlaps(
  fastify: FastifyInstance,
  tenantId: string,
  args: {
    employeeId: string;
    start: Date;
    duration: number | null;
    defaultMinutes: number;
    excludeId?: string;
  },
): Promise<OverlapResult> {
  const { employeeId, start, duration, defaultMinutes, excludeId } = args;
  if (!employeeId || Number.isNaN(start.getTime())) return NO_OVERLAP;

  const end = apptEnd(start, duration, defaultMinutes);
  const rows = await fastify.prisma.appointment.findMany({
    where: {
      tenantId,
      employeeId,
      deletedAt: null,
      status: { in: BUSY_STATUS },
      ...(excludeId && { id: { not: excludeId } }),
      date: {
        // Fereastra: orice programare care ar putea încă dura la ora de start.
        gte: new Date(start.getTime() - MAX_APPOINTMENT_MINUTES * 60_000),
        lt: end,
      },
    },
    select: { id: true, title: true, date: true, duration: true },
    orderBy: { date: "asc" },
    take: 20,
  });

  const items = rows
    .filter((r) => apptEnd(r.date, r.duration, defaultMinutes) > start)
    .map((r) => ({
      id: r.id,
      title: r.title,
      from: r.date.toISOString(),
      to: apptEnd(r.date, r.duration, defaultMinutes).toISOString(),
    }));

  return { hasOverlap: items.length > 0, count: items.length, items };
}
