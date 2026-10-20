import type { FastifyInstance } from "fastify";
import { readCompanySettings } from "./company-settings.js";
import { readSampleSettings, excludeSampleAppointments } from "./sample-settings.js";
import { SIGNATORY_ROLES, certForRole, stampOf, type SignatoryRole } from "../../lib/certifications.js";

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

/**
 * Avertisment (nu pas): documentele se pot genera, dar incomplet — ex. nimeni din
 * echipă nu are atestat RVT, deci raportul ISCIR iese fără numele și ștampila RVT.
 * Nu intră în procent; rămâne vizibil și după ce pașii sunt bifați.
 */
export interface ReadinessWarning {
  key: `signatory_${SignatoryRole}`;
  role: SignatoryRole;
  level: "missing" | "no_stamp" | "expired";
  title: string;
  description: string;
  href: string;
}

export interface ReadinessResponse {
  percent: number;
  complete: boolean;
  items: ReadinessItem[];
  warnings: ReadinessWarning[];
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
    warnings: await signatoryWarnings(fastify, tenantId, {
      anre: !!company.anreNr.trim(),
      iscir: !!tenant.iscirNumber?.trim(),
    }),
    sample: sampleClientExists && sample
      ? { present: true, clientId: sample.clientId, ...(sample.appointmentId && { appointmentId: sample.appointmentId }) }
      : { present: false },
    createdAt: tenant.createdAt.toISOString(),
  };
}

/** Pe ce documente semnează fiecare rol — pentru textul avertismentelor. */
const ROLE_DOCS: Record<SignatoryRole, { who: string; noun: string; docs: string; needs: "anre" | "iscir" }> = {
  instalator: { who: "instalator autorizat ANRE (EGIU, EGD…)", noun: "instalator autorizat", docs: "Fișele RT / FISA și PV-urile", needs: "anre" },
  rvt: { who: "RVT (atestat ISCIR)", noun: "RVT", docs: "Rapoartele ISCIR de revizie a centralei", needs: "iscir" },
  rsl: { who: "RSL-IP (atestat ISCIR)", noun: "RSL-IP", docs: "Rapoartele ISCIR de revizie a centralei", needs: "iscir" },
};

/**
 * Câte un avertisment per rol de semnatar (instalator / RVT / RSL-IP) fără o
 * persoană activă cu certificarea valabilă și ștampila încărcată. Rolurile se
 * filtrează după autorizațiile firmei (ANRE → instalator, ISCIR → RVT/RSL-IP);
 * fără niciuna (firmă nouă) se arată toate.
 */
async function signatoryWarnings(
  fastify: FastifyInstance,
  tenantId: string,
  has: { anre: boolean; iscir: boolean },
): Promise<ReadinessWarning[]> {
  const relevant = SIGNATORY_ROLES.filter((r) => (!has.anre && !has.iscir) || has[ROLE_DOCS[r.key].needs]);
  if (relevant.length === 0) return [];
  const employees = await fastify.prisma.employee.findMany({
    where: { tenantId, isActive: true },
    select: { certifications: { select: { type: true, expiresAt: true, stamp: { select: { s3Key: true } } } } },
  });
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const out: ReadinessWarning[] = [];
  for (const role of relevant) {
    const { who, noun, docs } = ROLE_DOCS[role.key];
    const holders = employees.flatMap((e) => {
      const cert = certForRole(role.key, e.certifications);
      return cert ? [{ cert, all: e.certifications }] : [];
    });
    const valid = holders.filter((h) => !h.cert.expiresAt || h.cert.expiresAt >= today);
    const base = { key: `signatory_${role.key}` as const, role: role.key, href: "/employees" };
    if (holders.length === 0) {
      out.push({
        ...base,
        level: "missing",
        title: `Nimeni din echipă nu e ${who}`,
        description: `${docs} se vor genera fără numele și ștampila de ${noun}. Adaugă certificarea la un angajat sau colaborator (Echipă → persoana → Certificări).`,
      });
    } else if (valid.length === 0) {
      out.push({
        ...base,
        level: "expired",
        title: `Certificarea de ${noun} a expirat`,
        description: `Toate certificările de ${noun} din echipă au expirat. ${docs} nu ar trebui emise până nu actualizezi data de valabilitate.`,
      });
    } else if (!valid.some((h) => stampOf(h.cert))) {
      out.push({
        ...base,
        level: "no_stamp",
        title: `Ștampila de ${noun} nu e încărcată`,
        description: `${docs} se vor genera fără ștampila de ${noun}. Încarcă imaginea ștampilei la certificarea persoanei (Echipă → persoana → Certificări).`,
      });
    }
  }
  return out;
}
