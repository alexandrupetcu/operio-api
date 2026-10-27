/**
 * Registrul câmpurilor de dosar (Carte Branșament / Carte Conductă / Dosar ISCIR):
 * fiecare variabilă din șabloane pe care o completează omul, cu o etichetă pe
 * înțelesul unui operator, pasul și secțiunea în care apare în pagina „Dosare”.
 *
 * Pagina arată doar câmpurile pe care le folosesc efectiv documentele grupului ales
 * (vezi `fieldsForPlaceholders`); restul variabilelor (firma, clientul, echipa,
 * numerele de registratură) se completează singure din date existente.
 */

import { DOSSIER_TABLES, PV_DATES, derivedDossierVars, type DossierTableColumn } from "./dossier-data.js";

export type DossierStep = "work" | "permits" | "materials";
/**
 * `textarea` = text pe mai multe rânduri (ex. lista documentelor materialelor);
 * `table` = rânduri cu coloane (`columns`), păstrat ca text: o linie pe rând, celule cu „|”;
 * `checkbox` = da / nu, păstrat ca „da” sau gol.
 */
export type DossierFieldType = "text" | "textarea" | "date" | "number" | "select" | "table" | "checkbox";

export interface DossierField {
  /** Cheia din șablon (și din `Project.metadata`). */
  key: string;
  label: string;
  help?: string;
  step: DossierStep;
  section: string;
  type: DossierFieldType;
  /** Unitatea afișată lângă câmp; poate depinde de categoria dosarului. */
  unit?: string | Partial<Record<string, string>>;
  options?: string[];
  /** Alte chei din șabloane cu același înțeles — primesc aceeași valoare. */
  aliases?: string[];
  default?: string;
  /** `project` = coloană a dosarului (nume, adresă), nu `metadata`. */
  source?: "metadata" | "project";
  /** Doar pentru `table`: coloanele și rândurile implicite (prima coloană). */
  columns?: DossierTableColumn[];
  rows?: string[];
  itemLabel?: string;
}

const table = (key: keyof typeof DOSSIER_TABLES & string) => ({
  type: "table" as const,
  columns: DOSSIER_TABLES[key].columns,
  rows: DOSSIER_TABLES[key].rows,
  itemLabel: DOSSIER_TABLES[key].itemLabel,
});

export const DOSSIER_STEPS: { key: DossierStep; label: string }[] = [
  { key: "work", label: "Lucrarea" },
  { key: "permits", label: "Avize și numere" },
  { key: "materials", label: "Materiale și probe" },
];

// Unitatea după categorie sau după distribuitorul grupului (NEOGAS și MegaConstruct scriu probele în bari).
const PRESSURE_UNIT = { DOSAR_ISCIR: "bar", NEOGAS_GRID: "bar", MEGACONSTRUCT: "bar", default: "Pa" };

/**
 * Operatorii de distribuție a gazelor naturale (OSD) cu care lucrează firmele —
 * denumirea legală, cum se scrie pe documente. Pagina pune întâi distribuitorii
 * firmei (Setări → Distribuitori); se poate scrie și alt nume.
 */
export const GAS_DISTRIBUTORS = [
  "Distrigaz Sud Rețele S.R.L.",
  "Delgaz Grid S.A.",
  "Premier Energy S.R.L.",
  "Megaconstruct S.A.",
  "Neogas Grid S.A.",
  "Gaz Est S.A.",
  "Gaz Vest S.A.",
  "Distrigaz Vest S.A.",
  "Congaz S.A.",
  "Nord Gaz S.R.L.",
  "Salgaz S.A.",
  "Tulcea Gaz S.A.",
  "Mehedinți Gaz S.A.",
  "Hargaz Harghita Gaz S.A.",
  "Prisma Serv Company S.R.L.",
  "Amarad Distribuție S.R.L.",
  "Cprog S.A.",
  "Vital Gaz S.A.",
];

export const DOSSIER_FIELDS: DossierField[] = [
  // ── Lucrarea ──────────────────────────────────────────────────────────────
  { key: "project_name", label: "Denumirea lucrării", help: "Cum apare lucrarea pe documente, ex. „Branșament gaze naturale imobil P+1”.", step: "work", section: "Lucrarea", type: "text", source: "project", aliases: ["PROJECT_NAME"] },
  { key: "obiectiv", label: "Obiectivul", help: "Ce se execută, ex. „Rețea de distribuție gaze naturale presiune redusă”.", step: "work", section: "Lucrarea", type: "text" },
  { key: "project_street_type", label: "Tip arteră", step: "work", section: "Adresa lucrării", type: "select", options: ["Str", "Bd", "Calea", "Aleea", "Șos", "Piața", "Intr", "Sat"], default: "Str" },
  { key: "lucrare_strada", label: "Strada", help: "Doar numele străzii, fără „Str.”.", step: "work", section: "Adresa lucrării", type: "text" },
  { key: "project_street_number", label: "Număr", step: "work", section: "Adresa lucrării", type: "text" },
  { key: "adresa_detalii", label: "Detalii adresă", help: "Opțional: număr vechi, număr cadastral — ex. „(Nr. vechi 432) – NC 20995”. Se tipăresc după număr.", step: "work", section: "Adresa lucrării", type: "text" },
  { key: "project_address", label: "Adresa completă", help: "Adresa așa cum apare în antetul documentelor.", step: "work", section: "Adresa lucrării", type: "text", source: "project" },
  { key: "project_city", label: "Localitatea", step: "work", section: "Adresa lucrării", type: "text", source: "project" },
  { key: "project_county", label: "Județul", step: "work", section: "Adresa lucrării", type: "text", source: "project" },
  { key: "project_dn", label: "Diametrul conductei (DN)", help: "Doar numărul, ex. 32 — documentele scriu „Dn 32 mm”.", step: "work", section: "Conducta", type: "text" },
  { key: "project_material", label: "Materialul conductei", step: "work", section: "Conducta", type: "select", options: ["PE 100", "PE 80", "OL", "Cupru"] },
  { key: "project_length", label: "Lungimea conductei", step: "work", section: "Conducta", type: "number", unit: "m" },
  { key: "bransament_lungime_reiser", label: "Lungimea reiserului", step: "work", section: "Conducta", type: "number", unit: "m" },
  { key: "bransament_lungime_totala", label: "Lungimea totală a branșamentului", help: "Lasă gol: se calculează lungimea conductei + reiserul.", step: "work", section: "Conducta", type: "number", unit: "m" },
  { key: "teu_dn", label: "Teul de branșament (DN)", help: "ex. 63/32 — primul număr e diametrul conductei stradale.", step: "work", section: "Conducta", type: "text" },
  { key: "bransament_presiune", label: "Regimul de presiune", step: "work", section: "Conducta", type: "select", options: ["Redusă presiune", "Medie presiune"] },
  { key: "zona_afectata", label: "Zona afectată", help: "Ce s-a spart și se readuce la starea inițială, ex. „Pietriș”, „Asfalt”.", step: "work", section: "Lucrarea", type: "text" },
  { key: "distanta_limita", label: "Distanța față de limita de proprietate", help: "ex. „1 m dreapta”", step: "work", section: "Lucrarea", type: "text" },
  { key: "sapatura_adancime", label: "Adâncimea săpăturii", step: "work", section: "Săpătura", type: "number", unit: "m" },
  { key: "sapatura_latime", label: "Lățimea săpăturii", step: "work", section: "Săpătura", type: "number", unit: "m" },
  { key: "mod_pozare", label: "Modul de pozare", help: "ex. „îngropat / foraj”", step: "work", section: "Fișa tehnică", type: "text" },
  { key: "tub_protectie_diametru", label: "Tubul de protecție — diametru", step: "work", section: "Fișa tehnică", type: "text" },
  { key: "tub_protectie_lungime", label: "Tubul de protecție — lungime", step: "work", section: "Fișa tehnică", type: "text" },
  { key: "tub_protectie_material", label: "Tubul de protecție — material", step: "work", section: "Fișa tehnică", type: "text" },
  { key: "robinet_diametru", label: "Robinetul — diametru", help: "ex. 1”", step: "work", section: "Fișa tehnică", type: "text" },
  { key: "robinet_bucati", label: "Robinetul — bucăți", step: "work", section: "Fișa tehnică", type: "number" },
  { key: "rasuflatori_cu_capace", label: "Răsuflători cu capace GN — bucăți", step: "work", section: "Fișa tehnică", type: "text" },
  { key: "rasuflatori_fara_capace", label: "Răsuflători fără capace GN — bucăți", step: "work", section: "Fișa tehnică", type: "text" },

  // ── Avize și numere ───────────────────────────────────────────────────────
  { key: "osd_denumire", label: "Denumirea distribuitorului", help: "Alege din listă sau „Alt distribuitor” ca să scrii numele.", step: "permits", section: "Distribuitorul (OSD)", type: "select", options: GAS_DISTRIBUTORS },
  { key: "osd_adresa", label: "Adresa agenției", step: "permits", section: "Distribuitorul (OSD)", type: "text" },
  { key: "osd_regiune", label: "Regiunea", help: "Din Setări → Distribuitori; completează aici doar ca să schimbi valoarea pe acest dosar.", step: "permits", section: "Distribuitorul (OSD)", type: "text" },
  { key: "osd_sector", label: "Sectorul / zona", help: "Din Setări → Distribuitori; completează aici doar ca să schimbi valoarea pe acest dosar.", step: "permits", section: "Distribuitorul (OSD)", type: "text" },
  { key: "osd_telefon", label: "Telefonul agenției", help: "Din Setări → Distribuitori; completează aici doar ca să schimbi valoarea pe acest dosar.", step: "permits", section: "Distribuitorul (OSD)", type: "text" },
  { key: "osd_fax", label: "Faxul agenției", help: "Din Setări → Distribuitori; completează aici doar ca să schimbi valoarea pe acest dosar.", step: "permits", section: "Distribuitorul (OSD)", type: "text" },
  { key: "osd_directia", label: "Direcția", help: "ex. Direcția Operațională Muntenia Nord", step: "permits", section: "Distribuitorul (OSD)", type: "text" },
  { key: "osd_punct_lucru", label: "Punctul de lucru", step: "permits", section: "Distribuitorul (OSD)", type: "text" },
  { key: "osd_delegat_nume", label: "Delegatul distribuitorului", help: "Numele delegatului OSD care semnează PV-urile de recepție calitativă.", step: "permits", section: "Distribuitorul (OSD)", type: "text" },
  { key: "osd_director", label: "Directorul care aprobă recepția", help: "ex. „IONIȚĂ Ion – Director Executiv”. Din Setări → Distribuitori; completează aici doar ca să schimbi valoarea pe acest dosar.", step: "permits", section: "Distribuitorul (OSD)", type: "text" },
  { key: "cod_atr", label: "Număr ATR / aviz tehnic de racordare", step: "permits", section: "Acte și avize", type: "text" },
  { key: "ordin_lucru", label: "Ordin de lucru — număr", step: "permits", section: "Acte și avize", type: "text" },
  { key: "data_ol", label: "Ordin de lucru — data", step: "permits", section: "Acte și avize", type: "date" },
  { key: "autorizatie_construire_nr", label: "Autorizație de construire / acord — număr", step: "permits", section: "Acte și avize", type: "text" },
  { key: "autorizatie_construire_data", label: "Autorizație de construire / acord — data", step: "permits", section: "Acte și avize", type: "date" },
  { key: "autorizatie_construire_emitent", label: "Autorizație de construire — emisă de", help: "ex. Primăria Ploiești", step: "permits", section: "Acte și avize", type: "text" },
  { key: "autorizatie_construire_valabilitate", label: "Autorizație de construire — valabilă până la", step: "permits", section: "Acte și avize", type: "date" },
  { key: "cod_sap", label: "Cod SAP", step: "permits", section: "Acte și avize", type: "text" },
  { key: "proiect_nr", label: "Numărul proiectului", step: "permits", section: "Proiect", type: "text", aliases: ["proiect_nr_documentatie"] },
  { key: "proiect_montaj", label: "Proiectul de montaj", step: "permits", section: "Proiect", type: "text" },
  { key: "planse_nr", label: "Numerele planșelor", help: "ex. 1, 2, 3", step: "permits", section: "Proiect", type: "text" },
  { key: "nr_schema_izometrica", label: "Numărul schemei izometrice", step: "permits", section: "Proiect", type: "text", aliases: ["schema_izometrica_nr"] },
  { key: "data_finalizare_montaj", label: "Data finalizării montajului", step: "permits", section: "Termene", type: "date" },
  { key: "data_finalizare_lucrari", label: "Data finalizării lucrărilor", step: "permits", section: "Termene", type: "date" },
  { key: "data_programare_receptie", label: "Data programării recepției", step: "permits", section: "Termene", type: "date" },
  { key: "data_pv_rt", label: "Data procesului-verbal de recepție tehnică", step: "permits", section: "Termene", type: "date" },
  { key: "data_incepere_executie", label: "Data începerii execuției", step: "permits", section: "Termene", type: "date" },
  { key: "data_pif", label: "Data punerii în funcțiune", step: "permits", section: "Termene", type: "date" },
  { key: "data_receptie_finala", label: "Data recepției finale", help: "Lasă gol dacă nu s-a făcut încă.", step: "permits", section: "Termene", type: "date" },
  { key: "pv_receptie_nr", label: "PV de recepție la terminarea lucrărilor — nr.", step: "permits", section: "Numerele documentelor", type: "text" },
  { key: "pv_control_calitate_nr", label: "PV de control al calității (fază determinantă) — nr.", step: "permits", section: "Numerele documentelor", type: "text" },
  { key: "pv_rt_br_nr", label: "PV de recepție tehnică a racordului — nr.", step: "permits", section: "Numerele documentelor", type: "text" },
  { key: "pv_rt_srm_nr", label: "PV de recepție tehnică a postului de reglare — nr.", step: "permits", section: "Numerele documentelor", type: "text" },
  { key: "pv_pif_nr", label: "PV de punere în funcțiune a racordului — nr.", step: "permits", section: "Numerele documentelor", type: "text" },
  { key: "pv_pif_srm_nr", label: "PV de punere în funcțiune a postului de reglare — nr.", step: "permits", section: "Numerele documentelor", type: "text" },
  { key: "pv_lucrari_ascunse_nr", label: "PV de lucrări ascunse — nr.", step: "permits", section: "Numerele documentelor", type: "text" },
  { key: "fisa_racord_nr", label: "Fișa tehnică a racordului — nr.", help: "ex. 1 / 2025", step: "permits", section: "Numerele documentelor", type: "text" },
  { key: "fisa_srm_nr", label: "Fișa tehnică a postului de reglare — nr.", help: "ex. 2 / 2025", step: "permits", section: "Numerele documentelor", type: "text" },
  { key: "rte_firma", label: "Firma responsabilului tehnic cu execuția", help: "Lasă gol dacă RTE-ul e al firmei care execută.", step: "permits", section: "Echipa", type: "text" },
  { key: "nr_comunicare_incepere", label: "Nr. comunicare de începere a lucrărilor", step: "permits", section: "ISCIR", type: "text" },
  { key: "nr_program_control", label: "Nr. program de control al calității", step: "permits", section: "ISCIR", type: "text" },

  // ── Materiale și probe ────────────────────────────────────────────────────
  { key: "teava_furnizor", label: "Furnizorul țevii", step: "materials", section: "Țeava", type: "text" },
  { key: "teava_cc_nr", label: "Certificat de calitate — număr", step: "materials", section: "Țeava", type: "text" },
  { key: "teava_dc_nr", label: "Declarație de conformitate — număr", step: "materials", section: "Țeava", type: "text" },
  { key: "teava_lot", label: "Lotul", step: "materials", section: "Țeava", type: "text" },
  { key: "teava_cc_data", label: "Certificat de calitate — data", step: "materials", section: "Țeava", type: "date" },
  { key: "teava_dc_data", label: "Declarație de conformitate — data", step: "materials", section: "Țeava", type: "date" },
  { key: "reiser_furnizor", label: "Furnizorul reiserului", help: "ex. EUROMILLING", step: "materials", section: "Reiser și firidă", type: "text" },
  { key: "reiser_lot", label: "Lotul reiserului", help: "ex. 2373/2024", step: "materials", section: "Reiser și firidă", type: "text" },
  { key: "firida_tip", label: "Tipul firidei", help: "ex. PRM S300", step: "materials", section: "Reiser și firidă", type: "text" },
  { key: "materiale", label: "Materialele racordului", help: "Câte un rând pe material: furnizor, certificat de calitate și declarație de conformitate.", step: "materials", section: "Materialele racordului", ...table("materiale") },
  { key: "materiale_srm", label: "Materialele postului de reglare", step: "materials", section: "Materialele postului de reglare", ...table("materiale_srm") },
  { key: "documente_materiale", label: "Documentele materialelor", help: "Facturi, certificate de calitate, declarații de conformitate — câte unul pe rând.", step: "materials", section: "Documentele materialelor", type: "textarea" },
  { key: "regulator_tip", label: "Tipul regulatorului", step: "materials", section: "Regulator", type: "text" },
  { key: "regulator_sn", label: "Seria regulatorului", step: "materials", section: "Regulator", type: "text" },
  { key: "procedeu_sudura", label: "Procedeul de sudură", step: "materials", section: "Sudura", type: "select", options: ["Electrofuziune", "Cap la cap", "Electrofuziune și cap la cap", "Sudură electrică cu arc"] },
  { key: "suduri_lista", label: "Sudurile executate", help: "Codurile sudurilor, despărțite prin virgulă, ex. „S79, S80, S81”. Tabelul și totalul se completează singure.", step: "materials", section: "Sudura", type: "text" },
  { key: "suduri_tabel", label: "Sudurile executate", help: "Câte un rând pe sudură, în ordinea din schema izometrică. Tabelul, buletinul de examinare și totalul se completează din el.", step: "materials", section: "Sudura", ...table("suduri_tabel") },
  { key: "schema_materiale", label: "Materialele din schema izometrică", step: "materials", section: "Sudura", ...table("schema_materiale") },
  { key: "aparat_sudura", label: "Aparatul de sudură", help: "Marca și seria aparatului.", step: "materials", section: "Sudura", type: "text" },
  { key: "aparat_sudura_ol", label: "Aparatul de sudură OL", help: "Marca și seria, ex. „AOTAI DURAARC 200 seria: 531200-00116”.", step: "materials", section: "Sudura", type: "text" },
  { key: "procedeu_omologare_pe", label: "Omologarea procedeului PE", help: "ex. 052-946 / 04.09.2024", step: "materials", section: "Sudura", type: "text" },
  { key: "procedeu_omologare_ol", label: "Omologarea procedeului OL", help: "ex. 89C-1150", step: "materials", section: "Sudura", type: "text" },
  { key: "bon_predare", label: "Bon de predare — număr", step: "materials", section: "Predare", type: "text" },
  { key: "bon_predare_data", label: "Bon de predare — data", step: "materials", section: "Predare", type: "date" },
  { key: "alocare_cont", label: "Alocare cont", step: "materials", section: "Predare", type: "text" },
  { key: "proba_rezistenta_presiune", label: "Presiunea de probă", step: "materials", section: "Proba de rezistență", type: "number", unit: PRESSURE_UNIT },
  { key: "proba_rezistenta_timp", label: "Durata probei", step: "materials", section: "Proba de rezistență", type: "number", unit: "minute", aliases: ["timp_proba_rezistenta"] },
  { key: "proba_rezistenta_temperatura", label: "Temperatura", step: "materials", section: "Proba de rezistență", type: "number", unit: "°C" },
  { key: "proba_etanseitate_presiune", label: "Presiunea de probă", step: "materials", section: "Proba de etanșeitate", type: "number", unit: PRESSURE_UNIT },
  { key: "proba_etanseitate_timp", label: "Durata probei", step: "materials", section: "Proba de etanșeitate", type: "number", unit: "minute", aliases: ["timp_proba_etanseitate"] },
  { key: "proba_etanseitate_temperatura", label: "Temperatura", step: "materials", section: "Proba de etanșeitate", type: "number", unit: "°C" },
  { key: "pv_data", label: "Data proceselor-verbale", help: "Data trecută pe PV-urile de șantier (predare, trasare, săpătură, probe, lucrări ascunse…).", step: "materials", section: "Procese-verbale", type: "date" },
  { key: "pv_date_diferite", label: "PV-urile au date diferite", help: "Bifează dacă PV-urile nu s-au încheiat toate în aceeași zi: apare câte o dată pentru fiecare, pornind de la data comună.", step: "materials", section: "Procese-verbale", type: "checkbox" },
  ...PV_DATES.map((d) => ({ key: d.key, label: `${d.label} — data`, step: "materials" as const, section: "Procese-verbale", type: "date" as const })),
  { key: "pv_predare_nr", label: "PV de predare a amplasamentului — nr.", step: "materials", section: "Procese-verbale", type: "text" },
  { key: "pv_trasare_nr", label: "PV de trasare — nr.", step: "materials", section: "Procese-verbale", type: "text" },
  { key: "pv_sapatura_nr", label: "PV de săpătură — nr.", step: "materials", section: "Procese-verbale", type: "text" },
  { key: "pv_asternere_nr", label: "PV de așternere a patului — nr.", step: "materials", section: "Procese-verbale", type: "text" },
  { key: "pv_montare_nr", label: "PV de montare — nr.", step: "materials", section: "Procese-verbale", type: "text" },
  { key: "pv_lansare_nr", label: "PV de lansare în șanț — nr.", step: "materials", section: "Procese-verbale", type: "text" },
  { key: "pv_rezistenta_nr", label: "PV probă de rezistență — nr.", step: "materials", section: "Procese-verbale", type: "text" },
  { key: "pv_etanseitate_nr", label: "PV probă de etanșeitate — nr.", step: "materials", section: "Procese-verbale", type: "text" },
  { key: "manometru_scala", label: "Scala manometrului", step: "materials", section: "Manometru", type: "text", help: "ex. 0–10 bar" },
  { key: "manometru_serie", label: "Seria manometrului", step: "materials", section: "Manometru", type: "text" },
  { key: "manometru_clasa", label: "Clasa de precizie", step: "materials", section: "Manometru", type: "text" },
  { key: "manometru_verif_metrologica", label: "Buletin de verificare metrologică", step: "materials", section: "Manometru", type: "text" },
];

/** Rolurile de echipă recunoscute în șabloane (`{rol}_nume`, `{rol}_decizie_nr`…). */
export const DOSSIER_ROLES = ["instalator", "proiectant", "rte", "sef_santier", "cq", "diriginte", "verificator", "sudor", "rts"] as const;
/** Câmpuri cerute la alocarea pe dosar (nu vin din certificările angajatului). */
export const ASSIGNMENT_FIELDS = ["decizie_nr", "decizie_data"] as const;

/**
 * Variabile completate automat — nu se cer în pagină: firma, clientul, datele
 * curente, registratura, imaginile, tabelul sudorilor și cel al sudurilor
 * (`{#suduri}{nr_crt} {cod} {rezultat}{/suduri}`, derivat din „Sudurile executate”).
 */
const AUTO_KEY = /^(tenant_|client_|current_|nr_inregistrare|data_inregistrare|project_(type|status|street)$|project_drawing$|project_sudori$|project_length_km$|teava_(cc|dc)_an$|bransament_presiune_abr$|conducta_stradala_dn$|adresa_detalii_text$|nr_crt$|sudor_(ol|pe)_|sudori_autorizatii$|suduri$|total_suduri$|cod$|rezultat$|year$)/;
/** Coloanele tabelelor (și ale buclei `sudori_autorizatii`) — nu se cer separat. */
const TABLE_COLUMN_KEYS = new Set([...Object.values(DOSSIER_TABLES).flatMap((t) => t.columns.map((c) => c.key)), "nume"]);
/** Coloane care există doar în tabelul sudurilor NEOGAS — o buclă `suduri` care le folosește cere tabelul. */
const SUDURI_TABEL_ONLY = ["sudor", "procedeu", "omologare"];
const ROLE_KEY = new RegExp(`^(${DOSSIER_ROLES.join("|")})_([a-z_]+)$`);

const PV_DATE_KEYS = new Set(PV_DATES.map((d) => d.key));
const BY_KEY = new Map<string, DossierField>();
for (const f of DOSSIER_FIELDS) for (const k of [f.key, ...(f.aliases ?? [])]) BY_KEY.set(k, f);

export function fieldForKey(key: string): DossierField | undefined {
  return BY_KEY.get(key);
}

export function unitFor(field: DossierField, categoryCode: string | null | undefined, distributorCode?: string | null): string | undefined {
  if (typeof field.unit === "string" || !field.unit) return field.unit;
  return (distributorCode && field.unit[distributorCode]) || (categoryCode && field.unit[categoryCode]) || field.unit.default;
}

/** Placeholderele dintr-un text de DOCX (fără tag-uri): `{x}`, `{#x}`, `{/x}`, `{%x}`. */
export function placeholdersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{([#/^%]?)\s*([A-Za-z0-9_]+)\s*\}/g)) out.add(`${m[1]}${m[2]}`);
  return out;
}

export interface GroupFieldPlan {
  /** Câmpurile din registru folosite de grup + cele necunoscute („Alte câmpuri”). */
  fields: { field: DossierField; docs: string[] }[];
  /** Rolurile cerute, cu câmpurile de alocare folosite (ex. `rte` → decizie_nr). */
  roles: { role: string; docs: string[]; assignmentFields: string[] }[];
  needsDrawing: boolean;
  /** Tabelul de sudori (`{#project_sudori}`): se pot alege mai mulți sudori. */
  usesSudoriTable: boolean;
}

/**
 * Din placeholderele fiecărui document al grupului → ce trebuie cerut omului.
 * Un placeholder care nu e nici în registru, nici completat automat, nici de rol,
 * ajunge la „Alte câmpuri”, cu cheia drept etichetă (șabloane încărcate de firmă).
 */
export function fieldsForPlaceholders(docs: { name: string; placeholders: Set<string> }[]): GroupFieldPlan {
  const fieldDocs = new Map<string, { field: DossierField; docs: Set<string> }>();
  const roleDocs = new Map<string, { docs: Set<string>; assignment: Set<string> }>();
  let needsDrawing = false;
  let usesSudoriTable = false;

  const addRole = (role: string, doc: string, assignment?: string) => {
    const r = roleDocs.get(role) ?? { docs: new Set(), assignment: new Set() };
    r.docs.add(doc);
    if (assignment) r.assignment.add(assignment);
    roleDocs.set(role, r);
  };

  for (const doc of docs) {
    for (const raw of doc.placeholders) {
      const key = raw.replace(/^[#/^%]/, "");
      if (raw.startsWith("/")) continue;
      if (key === "project_drawing") needsDrawing = true;
      if (key === "project_sudori" || key === "sudori_autorizatii") {
        usesSudoriTable = true;
        addRole("sudor", doc.name);
        continue;
      }
      if (/^sudor_(ol|pe)_/.test(key)) {
        addRole("sudor", doc.name);
        continue;
      }
      // Tabelul de suduri și totalul vin din „Sudurile executate”: tabelul complet
      // (NEOGAS: sudor, procedeu, omologare) sau doar lista codurilor (Distrigaz).
      const sudKey = SUDURI_TABEL_ONLY.some((c) => doc.placeholders.has(c)) ? "suduri_tabel" : "suduri_lista";
      const field = BY_KEY.get(key === "suduri" || key === "total_suduri" ? sudKey : key);
      if (field) {
        const e = fieldDocs.get(field.key) ?? { field, docs: new Set() };
        e.docs.add(doc.name);
        fieldDocs.set(field.key, e);
        continue;
      }
      if (AUTO_KEY.test(key) || raw.startsWith("%") || TABLE_COLUMN_KEYS.has(key)) continue;
      const role = ROLE_KEY.exec(key);
      if (role) {
        const [, r, suffix] = role;
        if (suffix === "signature") continue;
        addRole(r, doc.name, (ASSIGNMENT_FIELDS as readonly string[]).includes(suffix) ? suffix : undefined);
        continue;
      }
      const other: DossierField = { key, label: key, step: "materials", section: "Alte câmpuri", type: "text" };
      const e = fieldDocs.get(key) ?? { field: other, docs: new Set() };
      e.docs.add(doc.name);
      fieldDocs.set(key, e);
    }
  }

  // O dată de PV aduce și data comună + bifa „date diferite” (implicit, data comună le completează pe toate).
  const pvDocs = [...fieldDocs.values()].filter((e) => PV_DATE_KEYS.has(e.field.key)).flatMap((e) => [...e.docs]);
  if (pvDocs.length) {
    for (const key of ["pv_data", "pv_date_diferite"]) {
      const e = fieldDocs.get(key) ?? { field: BY_KEY.get(key)!, docs: new Set<string>() };
      for (const d of pvDocs) e.docs.add(d);
      fieldDocs.set(key, e);
    }
  }

  const order = new Map(DOSSIER_FIELDS.map((f, i) => [f.key, i]));
  const fields = [...fieldDocs.values()]
    .sort((a, b) => (order.get(a.field.key) ?? 1e6) - (order.get(b.field.key) ?? 1e6) || a.field.key.localeCompare(b.field.key))
    .map((e) => ({ field: e.field, docs: [...e.docs] }));
  const roles = DOSSIER_ROLES.filter((r) => roleDocs.has(r)).map((r) => ({
    role: r,
    docs: [...roleDocs.get(r)!.docs],
    assignmentFields: ASSIGNMENT_FIELDS.filter((f) => roleDocs.get(r)!.assignment.has(f)),
  }));
  return { fields, roles, needsDrawing, usesSudoriTable };
}

/**
 * Valorile metadata scrise și sub aliasuri (`proiect_nr` → `proiect_nr_documentatie`),
 * fără să suprascrie un alias completat explicit. Se aplică la generare.
 */
export function withAliases(meta: Record<string, unknown>): Record<string, unknown> {
  const out = { ...meta };
  for (const f of DOSSIER_FIELDS) {
    if (!f.aliases) continue;
    const v = out[f.key];
    for (const a of f.aliases) {
      if (v !== undefined && v !== "" && (out[a] === undefined || out[a] === "")) out[a] = v;
      // Și invers: un dosar vechi care a completat doar aliasul.
      else if ((v === undefined || v === "") && out[a] !== undefined && out[a] !== "") out[f.key] = out[a];
    }
  }
  return out;
}

/** Ce lipsește dintr-un dosar: câmpurile grupului fără valoare. */
export function dossierCompletion(
  plan: GroupFieldPlan,
  values: Record<string, unknown>,
  assignedRoles: Set<string>,
): { filled: number; total: number; missing: { key: string; label: string; step: DossierStep | "team"; docs: string[] }[] } {
  const missing: { key: string; label: string; step: DossierStep | "team"; docs: string[] }[] = [];
  let filled = 0;
  // Câmpurile calculate (ex. lungimea totală) nu se cer dacă se pot deduce.
  values = { ...values, ...derivedDossierVars(values) };
  const counted = plan.fields.filter((f) => f.field.type !== "checkbox");
  for (const { field, docs } of counted) {
    const v = values[field.key];
    if (v !== undefined && v !== null && String(v).trim() !== "") filled++;
    else missing.push({ key: field.key, label: field.label, step: field.step, docs });
  }
  for (const r of plan.roles) {
    if (assignedRoles.has(r.role)) filled++;
    else missing.push({ key: `role:${r.role}`, label: r.role, step: "team", docs: r.docs });
  }
  return { filled, total: counted.length + plan.roles.length, missing };
}
