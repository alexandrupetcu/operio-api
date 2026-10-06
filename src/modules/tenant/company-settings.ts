import type { PrismaClient, Prisma } from "@prisma/client";

/**
 * Firm-constant fields that appear on official gas-installation documents (RT/PV)
 * but aren't part of the core Tenant model. Stored in `Tenant.settingsJson.company`
 * so no migration is needed (mirrors `settingsJson.notifications`).
 */
export interface CompanySettings {
  anreNr: string;        // ANRE authorization number, e.g. "19833"
  anreTip: string;       // authorization type, e.g. "EDIB"
  anreData: string;      // issue date, e.g. "09.12.2020"
  anreExp: string;       // expiry date, e.g. "08.12.2025"
  iban: string;          // company IBAN
  bank: string;          // bank name, e.g. "ING BANK Suc. București"
  operatorSistem: string; // system operator (distributor) name for the header box
}

const EMPTY: CompanySettings = {
  anreNr: "", anreTip: "", anreData: "", anreExp: "", iban: "", bank: "", operatorSistem: "",
};

type SettingsJson = { company?: Partial<CompanySettings>; [k: string]: unknown };

/** Read the company block from a tenant's settingsJson, defaulting every field to "". */
export function readCompanySettings(settingsJson: unknown): CompanySettings {
  const s = settingsJson && typeof settingsJson === "object" ? (settingsJson as SettingsJson) : {};
  const c = s.company && typeof s.company === "object" ? s.company : {};
  return {
    anreNr: c.anreNr ?? "",
    anreTip: c.anreTip ?? "",
    anreData: c.anreData ?? "",
    anreExp: c.anreExp ?? "",
    iban: c.iban ?? "",
    bank: c.bank ?? "",
    operatorSistem: c.operatorSistem ?? "",
  };
}

/** Merge a partial patch into settingsJson.company, preserving other settings blocks. */
export async function setCompanySettings(
  prisma: PrismaClient,
  tenantId: string,
  patch: Partial<CompanySettings>,
): Promise<CompanySettings> {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { settingsJson: true },
  });
  const settings = tenant.settingsJson && typeof tenant.settingsJson === "object"
    ? { ...(tenant.settingsJson as SettingsJson) }
    : ({} as SettingsJson);
  const merged: CompanySettings = { ...EMPTY, ...readCompanySettings(tenant.settingsJson), ...patch };
  settings.company = merged;
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { settingsJson: settings as Prisma.InputJsonValue },
  });
  return merged;
}
