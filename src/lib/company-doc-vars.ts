import { readCompanySettings } from "../modules/tenant/company-settings.js";

/**
 * Datele firmei din Setări → Firmă (`settingsJson.company`) ca variabile de document,
 * aceleași pe ambele căi (HTML și DOCX). `tenant_autorizatie_*` sunt numele folosite
 * de dosarele DOCX (Carte Branșament, MegaConstruct, NEOGAS); `tenant_anre_*` de fișele HTML.
 */
export function companyDocVars(settingsJson: unknown): Record<string, string> {
  const c = readCompanySettings(settingsJson);
  return {
    tenant_anre_nr: c.anreNr,
    tenant_anre_tip: c.anreTip,
    tenant_anre_data: c.anreData,
    tenant_anre_exp: c.anreExp,
    tenant_autorizatie_anre: c.anreNr,
    tenant_autorizatie_data: c.anreData,
    tenant_iscir_exp: c.iscirExp,
    tenant_postal: c.postalCode,
    tenant_iban: c.iban,
    tenant_bank: c.bank,
    tenant_operator_sistem: c.operatorSistem,
    tenant_autorizatie_proiectare_nr: c.proiectareNr,
    tenant_autorizatie_proiectare_data: c.proiectareData,
    tenant_autorizatie_proiectare_tip: c.proiectareTip,
  };
}

/**
 * Datele firmei necompletate în Setări (adresă, telefon, CUI…) ies din datele DOCX, ca
 * generatorul să tipărească „..........” (de completat de mână) în loc de un gol care lasă
 * pe document „, , județul ,”. Imaginile și celelalte variabile rămân neatinse.
 */
export function withoutBlankTenantFields(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith("tenant_") && typeof v === "string" && !v.trim()) continue;
    out[k] = v;
  }
  return out;
}
