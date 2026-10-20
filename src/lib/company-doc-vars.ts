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
  };
}
