/**
 * Modul de programare al firmei — `Tenant.settingsJson.scheduling`.
 *
 * Firmele mici lucrează cu un calendar comun (comportamentul dinainte, rămâne
 * implicit). Cele mai mari vor calendare separate: fiecare tehnician vede doar
 * programările lui plus cele nerepartizate, iar restricția e impusă la API, nu
 * doar în interfață.
 *
 * `mode` e enum, nu boolean, ca un mod viitor („echipe") să nu ceară migrație;
 * programul de lucru și absențele vor intra ca chei surori sub `scheduling`, iar
 * `setSchedulingSettings` face merge, deci nimic nu se pierde.
 */
import type { PrismaClient, Prisma } from "@prisma/client";

export const SCHEDULING_MODES = [
  {
    key: "shared",
    label: "Calendar comun",
    description:
      "Toți văd toate programările. Potrivit firmelor mici, unde oricine poate prelua orice lucrare.",
  },
  {
    key: "per_technician",
    label: "Calendare separate",
    description:
      "Fiecare tehnician vede doar programările proprii și pe cele nerepartizate. Coordonatorii văd tot.",
  },
] as const;

export type SchedulingMode = (typeof SCHEDULING_MODES)[number]["key"];

export interface SchedulingSettings {
  mode: SchedulingMode;
  /** Avertizează la suprapunere pe același tehnician. Nu blochează niciodată salvarea. */
  warnOnOverlap: boolean;
  /** Durata presupusă când programarea nu are una — folosită la calculul orei de sfârșit. */
  defaultDurationMinutes: number;
}

export const SCHEDULING_DEFAULTS: SchedulingSettings = {
  mode: "shared",
  warnOnOverlap: true,
  defaultDurationMinutes: 60,
};

const MIN_DURATION = 5;
const MAX_DURATION = 480;

type SettingsJson = { scheduling?: Partial<SchedulingSettings>; [k: string]: unknown };

const isMode = (v: unknown): v is SchedulingMode =>
  SCHEDULING_MODES.some((m) => m.key === v);

/** Setările efective dintr-un settingsJson deja încărcat — cu default-urile completate. */
export function readSchedulingSettings(settingsJson: unknown): SchedulingSettings {
  const s = settingsJson && typeof settingsJson === "object" ? (settingsJson as SettingsJson) : {};
  const stored = s.scheduling && typeof s.scheduling === "object" ? s.scheduling : {};
  const duration = stored.defaultDurationMinutes;
  return {
    mode: isMode(stored.mode) ? stored.mode : SCHEDULING_DEFAULTS.mode,
    warnOnOverlap:
      typeof stored.warnOnOverlap === "boolean"
        ? stored.warnOnOverlap
        : SCHEDULING_DEFAULTS.warnOnOverlap,
    defaultDurationMinutes:
      typeof duration === "number" &&
      Number.isFinite(duration) &&
      duration >= MIN_DURATION &&
      duration <= MAX_DURATION
        ? Math.round(duration)
        : SCHEDULING_DEFAULTS.defaultDurationMinutes,
  };
}

/** Citire + fetch într-un singur apel (partea de service). */
export async function getSchedulingSettings(
  prisma: PrismaClient,
  tenantId: string,
): Promise<SchedulingSettings> {
  if (!tenantId) return { ...SCHEDULING_DEFAULTS };
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { settingsJson: true },
  });
  return readSchedulingSettings(tenant?.settingsJson);
}

/** Merge peste settingsJson.scheduling, păstrând blocurile surori. */
export async function setSchedulingSettings(
  prisma: PrismaClient,
  tenantId: string,
  patch: Partial<SchedulingSettings>,
): Promise<SchedulingSettings> {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { settingsJson: true },
  });
  const settings =
    tenant.settingsJson && typeof tenant.settingsJson === "object"
      ? { ...(tenant.settingsJson as SettingsJson) }
      : ({} as SettingsJson);
  const current = readSchedulingSettings(tenant.settingsJson);
  settings.scheduling = { ...current, ...patch };
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { settingsJson: settings as Prisma.InputJsonValue },
  });
  return readSchedulingSettings(settings);
}
