import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { osRegistrationDeadline } from "../../lib/working-days.js";
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
 * Fișe finalizate, încă neînregistrate la OS — pentru panoul principal. Întoarce și
 * termenul legal (5 zile lucrătoare de la finalizare).
 */
export async function listPendingOsRegistrations(fastify: FastifyInstance, tenantId: string) {
  // Fișa clientului de exemplu (onboarding) nu se înregistrează nicăieri.
  const sampleClientId = await getSampleClientId(fastify.prisma, tenantId);
  const rows = await fastify.prisma.appointment.findMany({
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
    return { ...r, completedAt, deadline: osRegistrationDeadline(completedAt) };
  });
}
