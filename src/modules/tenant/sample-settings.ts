import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Referința către datele de exemplu ale firmei (vezi sample-data.ts), ținută în
 * `Tenant.settingsJson.sample`. Helperele de aici nu au dependențe de Fastify,
 * ca să poată fi importate din rapoarte, panou și statistici fără cicluri.
 */
export interface SampleSettings {
  clientId: string;
  appointmentId: string | null;
  createdAt: string;
  /** Echipa de exemplu („Exemplu — …”); lipsă la exemplele create înainte de echipă. */
  employeeIds: string[];
  /** Rolurile de semnatar implicit pe care le-a completat exemplul (de golit la ștergere). */
  signatoryRolesSet: string[];
  /** Dosarul de exemplu (Carte branșament), dacă s-a putut crea. */
  dossierId: string | null;
}

type SettingsJson = { sample?: Partial<SampleSettings> | null; [k: string]: unknown };

/** Blocul `sample` din settingsJson, sau null dacă nu există / e incomplet. */
export function readSampleSettings(settingsJson: unknown): SampleSettings | null {
  const s = settingsJson && typeof settingsJson === "object" ? (settingsJson as SettingsJson) : {};
  const sample = s.sample;
  if (!sample || typeof sample !== "object" || typeof sample.clientId !== "string") return null;
  return {
    clientId: sample.clientId,
    appointmentId: typeof sample.appointmentId === "string" ? sample.appointmentId : null,
    createdAt: typeof sample.createdAt === "string" ? sample.createdAt : "",
    employeeIds: strings(sample.employeeIds),
    signatoryRolesSet: strings(sample.signatoryRolesSet),
    dossierId: typeof sample.dossierId === "string" ? sample.dossierId : null,
  };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Id-urile angajaților de exemplu ai firmei (listă goală dacă nu există). */
export function sampleEmployeeIds(settingsJson: unknown): string[] {
  return readSampleSettings(settingsJson)?.employeeIds ?? [];
}

/**
 * Id-ul clientului de exemplu al firmei (sau null). Un singur SELECT pe Tenant —
 * de apelat o dată per cerere, acolo unde rândurile de exemplu trebuie excluse.
 */
export async function getSampleClientId(
  prisma: PrismaClient | Prisma.TransactionClient,
  tenantId: string,
): Promise<string | null> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { settingsJson: true } });
  return readSampleSettings(tenant?.settingsJson)?.clientId ?? null;
}

/**
 * Filtru Prisma care exclude programările clientului de exemplu. Scris cu OR
 * explicit pe NULL: `clientId: { not: x }` singur ar scoate din rezultat și
 * programările fără client (SQL `<>` cu NULL).
 */
export function excludeSampleAppointments(sampleClientId: string | null): Prisma.AppointmentWhereInput {
  if (!sampleClientId) return {};
  return { OR: [{ clientId: null }, { clientId: { not: sampleClientId } }] };
}

/** Scrie (sau șterge, cu null) blocul `sample`, păstrând celelalte setări. */
export async function writeSampleSettings(
  prisma: PrismaClient | Prisma.TransactionClient,
  tenantId: string,
  sample: SampleSettings | null,
): Promise<void> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settingsJson: true } });
  const settings: SettingsJson =
    tenant.settingsJson && typeof tenant.settingsJson === "object" ? { ...(tenant.settingsJson as SettingsJson) } : {};
  if (sample) settings.sample = sample;
  else delete settings.sample;
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { settingsJson: settings as Prisma.InputJsonValue },
  });
}
