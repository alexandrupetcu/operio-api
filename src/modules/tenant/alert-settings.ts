import type { PrismaClient, Prisma } from "@prisma/client";

/**
 * Tenant-configurable alert windows for the dashboard action feed (and the
 * ISCIR next-revision date on documents). Stored in `Tenant.settingsJson.alertWindows`
 * as { [key]: number } — only overrides are persisted; missing keys fall back to
 * the registry defaults (mirrors `settingsJson.notifications` / `.company`).
 */
export const ALERT_WINDOWS = [
  {
    key: "revisionIntervalYears",
    label: "Interval revizie centrală",
    description: "Perioada de valabilitate a unei revizii de centrală (ani). Determină data de expirare și scadența de pe raportul ISCIR.",
    group: "Revizii",
    default: 2,
    min: 1,
    max: 10,
    unit: "ani",
  },
  {
    key: "revisionWarningDays",
    label: "Avertizare expirare revizie",
    description: "Cu câte zile înainte de expirarea reviziei apare alerta pe panoul principal.",
    group: "Revizii",
    default: 45,
    min: 1,
    max: 365,
    unit: "zile",
  },
  {
    key: "revisionDangerDays",
    label: "Prag critic revizie",
    description: "Sub câte zile rămase alerta de revizie devine critică (roșie, prioritate ridicată).",
    group: "Revizii",
    default: 15,
    min: 0,
    max: 365,
    unit: "zile",
  },
  {
    key: "fleetItpDays",
    label: "Avertizare ITP",
    description: "Cu câte zile înainte de expirarea ITP apare alerta de flotă.",
    group: "Flotă",
    default: 30,
    min: 1,
    max: 365,
    unit: "zile",
  },
  {
    key: "fleetRcaDays",
    label: "Avertizare RCA",
    description: "Cu câte zile înainte de expirarea RCA apare alerta de flotă.",
    group: "Flotă",
    default: 30,
    min: 1,
    max: 365,
    unit: "zile",
  },
  {
    key: "fleetVignetteDays",
    label: "Avertizare Rovinietă",
    description: "Cu câte zile înainte de expirarea rovinietei apare alerta de flotă.",
    group: "Flotă",
    default: 30,
    min: 1,
    max: 365,
    unit: "zile",
  },
  {
    key: "vehicleServiceIntervalKm",
    label: "Interval revizie auto (km)",
    description: "La câți kilometri de la ultima revizie mecanică devine scadentă următoarea (se estimează din km/lună al vehiculului).",
    group: "Flotă",
    default: 10000,
    min: 1000,
    max: 100000,
    unit: "km",
  },
  {
    key: "vehicleServiceIntervalMonths",
    label: "Interval revizie auto (luni)",
    description: "După câte luni de la ultima revizie mecanică devine scadentă următoarea — se aplică ce se atinge primul (km sau luni).",
    group: "Flotă",
    default: 12,
    min: 1,
    max: 60,
    unit: "luni",
  },
  {
    key: "fleetServiceDays",
    label: "Avertizare revizie auto",
    description: "Cu câte zile înainte de scadența estimată a reviziei auto apare alerta de flotă.",
    group: "Flotă",
    default: 30,
    min: 1,
    max: 365,
    unit: "zile",
  },
  {
    key: "deadlineUpcomingDays",
    label: "Fereastră termene apropiate",
    description: "Câte zile înainte intră în panou task-urile, pașii de workflow și deadline-urile de proiect.",
    group: "Termene",
    default: 7,
    min: 1,
    max: 90,
    unit: "zile",
  },
  {
    key: "deadlineUrgentDays",
    label: "Prag urgent termene",
    description: "Sub câte zile rămase un termen este marcat URGENT (roșu).",
    group: "Termene",
    default: 3,
    min: 0,
    max: 30,
    unit: "zile",
  },
] as const;

export type AlertWindowKey = (typeof ALERT_WINDOWS)[number]["key"];
export type AlertWindows = Record<AlertWindowKey, number>;

type SettingsJson = { alertWindows?: Partial<Record<string, number>>; [k: string]: unknown };

/** Effective windows from a tenant's settingsJson — defaults filled in. */
export function readAlertWindows(settingsJson: unknown): AlertWindows {
  const s = settingsJson && typeof settingsJson === "object" ? (settingsJson as SettingsJson) : {};
  const stored = s.alertWindows && typeof s.alertWindows === "object" ? s.alertWindows : {};
  const out = {} as AlertWindows;
  for (const w of ALERT_WINDOWS) {
    const v = stored[w.key];
    out[w.key] = typeof v === "number" && Number.isFinite(v) && v >= w.min && v <= w.max ? v : w.default;
  }
  return out;
}

/** Fetch + read in one call (dashboard/service side). */
export async function getAlertWindows(prisma: PrismaClient, tenantId: string): Promise<AlertWindows> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { settingsJson: true },
  });
  return readAlertWindows(tenant?.settingsJson);
}

/** Merge a partial patch into settingsJson.alertWindows, preserving sibling blocks. */
export async function setAlertWindows(
  prisma: PrismaClient,
  tenantId: string,
  patch: Partial<AlertWindows>,
): Promise<AlertWindows> {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { settingsJson: true },
  });
  const settings = tenant.settingsJson && typeof tenant.settingsJson === "object"
    ? { ...(tenant.settingsJson as SettingsJson) }
    : ({} as SettingsJson);
  const current = readAlertWindows(tenant.settingsJson);
  settings.alertWindows = { ...current, ...patch };
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { settingsJson: settings as Prisma.InputJsonValue },
  });
  return readAlertWindows(settings);
}
