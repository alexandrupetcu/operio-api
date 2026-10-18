import type { FastifyInstance } from "fastify";
import { readCompanySettings } from "./company-settings.js";
import { readSampleSettings, excludeSampleAppointments } from "./sample-settings.js";

/**
 * Lista de pornire a unei firme noi („ești gata să emiți documente?”). Fiecare
 * punct are o legătură către pagina unde se rezolvă. UI-ul arată lista doar
 * pentru firme tinere (< 60 zile) sau încă incomplete — de aceea răspunsul
 * poartă și `createdAt`.
 */
export type ReadinessKey = "company" | "branding" | "employee" | "client" | "visit";

export interface ReadinessItem {
  key: ReadinessKey;
  label: string;
  description: string;
  done: boolean;
  href: string;
  /** Observație afișată lângă un punct bifat (ex. „niciun tehnician nu are acces mobil”). */
  hint?: string;
}

export interface ReadinessResponse {
  percent: number;
  complete: boolean;
  items: ReadinessItem[];
  sample: { present: boolean; clientId?: string; appointmentId?: string };
  createdAt: string;
}

/** Cache per firmă, în memorie — răspunsul e cerut la fiecare deschidere a panoului. */
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { expires: number; value: ReadinessResponse }>();

/** De apelat după scrierile care schimbă lista (date de exemplu, import clienți). */
export function invalidateReadiness(tenantId: string): void {
  cache.delete(tenantId);
}

export async function getReadiness(fastify: FastifyInstance, tenantId: string): Promise<ReadinessResponse> {
  const hit = cache.get(tenantId);
  if (hit && hit.expires > Date.now()) return hit.value;

  const value = await computeReadiness(fastify, tenantId);
  cache.set(tenantId, { expires: Date.now() + CACHE_TTL_MS, value });
  return value;
}

async function computeReadiness(fastify: FastifyInstance, tenantId: string): Promise<ReadinessResponse> {
  const prisma = fastify.prisma;
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { createdAt: true, iscirNumber: true, stampS3Key: true, signatureS3Key: true, settingsJson: true },
  });
  const company = readCompanySettings(tenant.settingsJson);
  const sample = readSampleSettings(tenant.settingsJson);
  const sampleClientId = sample?.clientId ?? null;

  const [activeEmployees, mobileEmployees, clients, completedVisits, sampleClientExists] = await Promise.all([
    prisma.employee.count({ where: { tenantId, isActive: true } }),
    prisma.employee.count({ where: { tenantId, isActive: true, user: { is: { mobileAccess: true, isActive: true } } } }),
    prisma.client.count({ where: { tenantId, ...(sampleClientId && { id: { not: sampleClientId } }) } }),
    prisma.appointment.count({
      where: { tenantId, deletedAt: null, status: "completed", ...excludeSampleAppointments(sampleClientId) },
    }),
    sampleClientId ? prisma.client.count({ where: { id: sampleClientId, tenantId } }).then((n) => n > 0) : Promise.resolve(false),
  ]);

  const items: ReadinessItem[] = [
    {
      key: "company",
      label: "Datele firmei pentru documente",
      description: "Autorizația ANRE, numărul ISCIR și IBAN-ul apar pe fișe și contracte.",
      done: !!company.anreNr.trim() && !!tenant.iscirNumber?.trim() && !!company.iban.trim(),
      href: "/settings?tab=company",
    },
    {
      key: "branding",
      label: "Ștampila și semnătura",
      description: "Se aplică automat pe documentele generate.",
      done: !!tenant.stampS3Key && !!tenant.signatureS3Key,
      href: "/settings?tab=company",
    },
    {
      key: "employee",
      label: "Primul tehnician",
      description: "Tehnicienii apar pe fișe și primesc programările în aplicația mobilă.",
      done: activeEmployees > 0,
      href: "/employees",
      ...(activeEmployees > 0 && mobileEmployees === 0 && { hint: "Niciun tehnician nu are acces mobil încă" }),
    },
    {
      key: "client",
      label: "Primul client",
      description: "Adaugă un client manual sau importă lista din Excel.",
      done: clients > 0,
      href: "/clients",
    },
    {
      key: "visit",
      label: "Prima vizită finalizată",
      description: "O programare finalizată din aplicația mobilă generează documentele automat.",
      done: completedVisits > 0,
      href: "/calendar",
    },
  ];

  const done = items.filter((i) => i.done).length;
  return {
    percent: Math.round((done / items.length) * 100),
    complete: done === items.length,
    items,
    sample: sampleClientExists && sample
      ? { present: true, clientId: sample.clientId, ...(sample.appointmentId && { appointmentId: sample.appointmentId }) }
      : { present: false },
    createdAt: tenant.createdAt.toISOString(),
  };
}
