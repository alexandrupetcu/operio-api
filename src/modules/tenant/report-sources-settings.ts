/**
 * Strategiile de raport ale firmei — `Tenant.settingsJson.reportSources`.
 *
 * Pentru fiecare tip de programare cu raport (revizie centrală, revizie /
 * verificare instalație) firma alege cum ajung datele în sistem:
 *   - `wizard`: tehnicianul completează formularul (comportamentul de până acum;
 *     un PDF importat doar pre-completează câmpurile);
 *   - `import`: PDF-ul analizorului e sursa de date (citirile se extrag);
 *   - `attach`: PDF-ul se atașează fără extragere.
 * `sourceId` = sursa din registru sau `auto` (detecție după text).
 * `sourceMappings` = pentru sursele cu mapping (AI): etichetă tipărită → cheia
 * noastră, per sursă.
 */
import type { PrismaClient, Prisma } from "@prisma/client";
import { isSourceId } from "../../lib/report-sources/index.js";

export const REPORT_TYPE_KEYS = ["revizie", "revizie_instalatie", "verificare_instalatie"] as const;
export type ReportTypeKey = (typeof REPORT_TYPE_KEYS)[number];

export const REPORT_STRATEGIES = ["wizard", "import", "attach"] as const;
export type ReportStrategy = (typeof REPORT_STRATEGIES)[number];

export const AUTO_SOURCE = "auto";

export interface ReportTypeConfig {
  key: ReportTypeKey;
  strategy: ReportStrategy;
  /** `auto` sau id-ul unei surse din registru. */
  sourceId: string;
  /** Chei (din `ReportSource.fields`) fără de care importul e considerat incomplet. */
  requiredFields: string[];
}

export interface ReportSourcesSettings {
  reportTypes: ReportTypeConfig[];
  sourceMappings: Record<string, Record<string, string>>;
}

export const REPORT_SOURCES_DEFAULTS: ReportSourcesSettings = {
  reportTypes: REPORT_TYPE_KEYS.map((key) => ({
    key,
    strategy: "wizard",
    sourceId: AUTO_SOURCE,
    requiredFields: [],
  })),
  sourceMappings: {},
};

type SettingsJson = { reportSources?: unknown; [k: string]: unknown };

const isReportTypeKey = (v: unknown): v is ReportTypeKey =>
  REPORT_TYPE_KEYS.includes(v as ReportTypeKey);
const isStrategy = (v: unknown): v is ReportStrategy =>
  REPORT_STRATEGIES.includes(v as ReportStrategy);

function readMappings(raw: unknown): Record<string, Record<string, string>> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, Record<string, string>> = {};
  for (const [sourceId, map] of Object.entries(raw as Record<string, unknown>)) {
    if (!map || typeof map !== "object") continue;
    const clean: Record<string, string> = {};
    for (const [label, key] of Object.entries(map as Record<string, unknown>)) {
      if (typeof key === "string" && key.trim() && label.trim()) clean[label] = key.trim();
    }
    out[sourceId] = clean;
  }
  return out;
}

/**
 * Setările efective dintr-un settingsJson deja încărcat — toate cele trei tipuri
 * prezente, în ordine fixă, cu default-urile completate; valorile necunoscute
 * (sursă ștearsă din registru, strategie inventată) cad pe default.
 */
export function readReportSourcesSettings(settingsJson: unknown): ReportSourcesSettings {
  const s = settingsJson && typeof settingsJson === "object" ? (settingsJson as SettingsJson) : {};
  const stored =
    s.reportSources && typeof s.reportSources === "object"
      ? (s.reportSources as Record<string, unknown>)
      : {};
  const storedTypes = Array.isArray(stored.reportTypes) ? (stored.reportTypes as unknown[]) : [];

  const reportTypes = REPORT_TYPE_KEYS.map((key): ReportTypeConfig => {
    const def = REPORT_SOURCES_DEFAULTS.reportTypes.find((t) => t.key === key)!;
    const raw = storedTypes.find(
      (t) => t && typeof t === "object" && (t as Record<string, unknown>).key === key,
    ) as Record<string, unknown> | undefined;
    if (!raw) return { ...def, requiredFields: [] };
    const sourceId = raw.sourceId;
    return {
      key,
      strategy: isStrategy(raw.strategy) ? raw.strategy : def.strategy,
      sourceId: sourceId === AUTO_SOURCE || isSourceId(sourceId) ? (sourceId as string) : AUTO_SOURCE,
      requiredFields: Array.isArray(raw.requiredFields)
        ? (raw.requiredFields as unknown[]).filter((f): f is string => typeof f === "string" && !!f)
        : [],
    };
  });

  return { reportTypes, sourceMappings: readMappings(stored.sourceMappings) };
}

/** Configurația unui tip de programare, sau null dacă tipul nu are raport. */
export function getReportTypeConfig(
  settings: ReportSourcesSettings,
  type: string,
): ReportTypeConfig | null {
  if (!isReportTypeKey(type)) return null;
  return settings.reportTypes.find((t) => t.key === type) ?? null;
}

export async function getReportSourcesSettings(
  prisma: PrismaClient,
  tenantId: string,
): Promise<ReportSourcesSettings> {
  if (!tenantId) return readReportSourcesSettings(null);
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { settingsJson: true },
  });
  return readReportSourcesSettings(tenant?.settingsJson);
}

/** Înlocuiește blocul `reportSources` (validat deja), păstrând blocurile surori. */
export async function setReportSourcesSettings(
  prisma: PrismaClient,
  tenantId: string,
  next: ReportSourcesSettings,
): Promise<ReportSourcesSettings> {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { settingsJson: true },
  });
  const settings =
    tenant.settingsJson && typeof tenant.settingsJson === "object"
      ? { ...(tenant.settingsJson as SettingsJson) }
      : ({} as SettingsJson);
  // Normalizăm prin cititor ca pe disc să ajungă exact forma pe care o citim.
  settings.reportSources = readReportSourcesSettings({ reportSources: next });
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { settingsJson: settings as Prisma.InputJsonValue },
  });
  return readReportSourcesSettings(settings);
}
