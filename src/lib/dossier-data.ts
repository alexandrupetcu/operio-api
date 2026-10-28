/**
 * Variabilele de dosar calculate din date existente (fără I/O, testabile):
 * agenția distribuitorului, câmpurile derivate și echipa. Folosite de worker-ul
 * de generare (ramura de proiect) — vezi docs/bransament-analiza-2026-10/contract-variabile.md.
 */

type Meta = Record<string, unknown>;

const filled = (v: unknown): v is string | number => (typeof v === "string" && v.trim() !== "") || typeof v === "number";
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Cheia de dosar → câmpul din `Distributor.contactJson`. */
const OSD_CONTACT_KEYS: [string, string][] = [
  ["osd_adresa", "address"],
  ["osd_regiune", "region"],
  ["osd_sector", "sector"],
  ["osd_telefon", "phone"],
  ["osd_fax", "fax"],
  ["osd_director", "director"],
];

/**
 * Datele agenției OSD din Setări → Distribuitori. O valoare completată pe dosar
 * are prioritate; una goală nu ascunde ce e pe distribuitor.
 */
export function distributorDocVars(distributor: { name: string; contactJson: unknown } | null, meta: Meta): Record<string, string> {
  if (!distributor) return {};
  const out: Record<string, string> = {};
  const pick = (key: string, fallback: string) => {
    const own = meta[key];
    if (filled(own)) out[key] = String(own).trim();
    else if (fallback) out[key] = fallback;
  };
  pick("osd_denumire", distributor.name ?? "");
  const contact = distributor.contactJson && typeof distributor.contactJson === "object" && !Array.isArray(distributor.contactJson)
    ? (distributor.contactJson as Record<string, unknown>)
    : {};
  for (const [key, field] of OSD_CONTACT_KEYS) pick(key, str(contact[field]));
  return out;
}

// ── Câmpuri-tabel (materialele și sudurile din dosarele NEOGAS) ──

export interface DossierTableColumn {
  key: string;
  label: string;
}
export interface DossierTable {
  /** Ce e un rând, pentru butonul „Adaugă …” din pagina Dosare. */
  itemLabel: string;
  columns: DossierTableColumn[];
  /** Rândurile tipărite când tabelul e necompletat (prima coloană), ca să se scrie de mână. */
  rows?: string[];
}

const MATERIAL_COLUMNS: DossierTableColumn[] = [
  { key: "denumire", label: "Material" },
  { key: "diametru", label: "Diametru (mm)" },
  { key: "cantitate", label: "Cantitate (m / buc)" },
  { key: "furnizor", label: "Furnizor" },
  { key: "certificat", label: "Certificat de calitate (nr. / dată)" },
  { key: "declaratie", label: "Declarație de conformitate (nr. / dată)" },
];

/**
 * Tabelele din pagina Dosare. Valoarea se păstrează ca text (metadata e doar text):
 * un rând pe linie, celulele despărțite prin „|”. În șabloane: `{#materiale}{denumire}…{/materiale}`.
 */
export const DOSSIER_TABLES: Record<string, DossierTable> = {
  materiale: {
    itemLabel: "material",
    columns: MATERIAL_COLUMNS,
    rows: [
      "Capăt branșament PE-OL",
      "Țeavă PE",
      "Mufă electrofuziune",
      "Armătură închidere OL",
      "Tub protecție OL/PVC",
      "Teu branșament OL",
      "Fir trasor",
      "Nisip",
      "Cămin armături",
      "Răsuflători SV",
      "Capace GN",
    ],
  },
  materiale_srm: {
    itemLabel: "material",
    columns: MATERIAL_COLUMNS,
    rows: ["Țeavă PE", "Armătură închidere OL", "Regulator de presiune", "Contor", "Firidă"],
  },
  schema_materiale: {
    itemLabel: "material",
    columns: [
      { key: "denumire", label: "Material" },
      { key: "cantitate", label: "Cantitate (m / buc)" },
      { key: "nr_suduri", label: "Sudurile pe el (ex. S3, S4)" },
    ],
    rows: ["Teu branșament OL", "Piesă de tranziție OL-PE", "Mufă EF", "Țeavă PE", "Cap de branșament", "Robinet cu bilă"],
  },
  suduri_tabel: {
    itemLabel: "sudură",
    columns: [
      { key: "cod", label: "Nr. sudură (ex. S1)" },
      { key: "sudor", label: "Sudor" },
      { key: "autorizatie", label: "Poanson / autorizație" },
      { key: "procedeu", label: "Tip / procedeu (ex. SRM/SW)" },
      { key: "omologare", label: "Fișa de omologare a procedeului" },
    ],
  },
};

/**
 * Datele proceselor-verbale de șantier. Implicit toate sunt „Data proceselor-verbale” (`pv_data`);
 * cu bifa `pv_date_diferite`, fiecare PV are data lui (necompletată → data comună).
 */
export const PV_DATES: { key: string; label: string }[] = [
  { key: "pv_predare_data", label: "PV de predare a amplasamentului" },
  { key: "pv_trasare_data", label: "PV de trasare" },
  { key: "pv_sapatura_data", label: "PV de săpătură" },
  { key: "pv_asternere_data", label: "PV de așternere a patului de nisip" },
  { key: "pv_montare_data", label: "PV de montare a conductei" },
  { key: "pv_lansare_data", label: "PV de lansare în șanț și astupare" },
  { key: "pv_fir_trasor_data", label: "PV de verificare a firului trasor" },
  { key: "pv_rezistenta_data", label: "PV probă de rezistență" },
  { key: "pv_etanseitate_data", label: "PV probă de etanșeitate" },
  { key: "pv_lucrari_ascunse_data", label: "PV de lucrări ascunse" },
  { key: "pv_control_calitate_data", label: "PV de control al calității" },
];

/** Text de tabel → rânduri `{nr_crt, coloană: valoare}`; gol → rândurile implicite. */
export function parseDossierTable(table: DossierTable, value: unknown): Record<string, string>[] {
  const lines = str(value)
    .split(/\r?\n/)
    .filter((l) => l.replace(/\|/g, "").trim() !== "");
  const cells = lines.length ? lines.map((l) => l.split("|").map((c) => c.trim())) : (table.rows ?? []).map((r) => [r]);
  return cells.map((row, i) => {
    const out: Record<string, string> = { nr_crt: String(i + 1) };
    table.columns.forEach((c, j) => (out[c.key] = row[j] ?? ""));
    return out;
  });
}

/** Rânduri goale pentru o buclă de tabel (inclusiv `nr_crt`). */
function blankRows(count: number, keys: string[]): Record<string, string>[] {
  return Array.from({ length: count }, () => Object.fromEntries(["nr_crt", ...keys].map((k) => [k, ""])));
}

/** „04.08.2025” / „2025-08-04” → „2025”. */
function yearOf(v: unknown): string | null {
  const s = str(v);
  return /\b(\d{4})-\d{2}-\d{2}\b/.exec(s)?.[1] ?? /\b\d{1,2}[./]\d{1,2}[./](\d{4})\b/.exec(s)?.[1] ?? null;
}

/** „2,00” / „2.00” / 2 → 2; altfel null. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v.trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Zecimale ca în cel mai precis operand (2.00 + 1.30 → „3.30”). */
function decimals(v: unknown): number {
  const m = /[.,](\d+)\s*$/.exec(String(v ?? ""));
  return m ? m[1].length : 0;
}

/**
 * Câmpuri calculate din metadata dosarului:
 * - `bransament_lungime_totala` = lungime + reiser, când omul n-a completat-o;
 * - `suduri[]` + `total_suduri` din tabelul sudurilor (NEOGAS) sau din `suduri_lista` („S79, S80, S81”);
 * - tabelele (`materiale[]`…), lungimea în km, anul certificatelor țevii, firma RTE;
 * - `project_street` din strada salvată în pagina Dosare (`lucrare_strada`).
 */
export function derivedDossierVars(meta: Meta): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!filled(meta.project_street) && filled(meta.lucrare_strada)) out.project_street = str(meta.lucrare_strada);
  if (!filled(meta.bransament_lungime_totala)) {
    const len = num(meta.project_length);
    const reiser = num(meta.bransament_lungime_reiser);
    if (len !== null && reiser !== null) {
      const d = Math.max(decimals(meta.project_length), decimals(meta.bransament_lungime_reiser));
      out.bransament_lungime_totala = (len + reiser).toFixed(d);
    }
  }
  const total = num(out.bransament_lungime_totala ?? meta.bransament_lungime_totala);
  if (total !== null) out.project_length_km = (total / 1000).toFixed(3).replace(".", ",");

  for (const [key, table] of Object.entries(DOSSIER_TABLES)) {
    if (key !== "suduri_tabel") out[key] = parseDossierTable(table, meta[key]);
  }
  if (filled(meta.suduri_tabel)) {
    out.suduri = parseDossierTable(DOSSIER_TABLES.suduri_tabel, meta.suduri_tabel).map((r) => ({ ...r, rezultat: "ADMIS" }));
  } else {
    const codes = str(meta.suduri_lista)
      .split(/[,;\n]+/)
      .map((c) => c.trim())
      .filter(Boolean);
    out.suduri = codes.map((cod, i) => ({ nr_crt: String(i + 1), cod, rezultat: "ADMIS" }));
  }
  const n = (out.suduri as unknown[]).length;
  out.total_suduri = n ? String(n) : "";
  // Fără suduri: câteva rânduri goale, ca tabelele (execuția sudurilor, buletinul) să se poată completa de mână.
  if (!n) out.suduri = blankRows(4, ["cod", "sudor", "autorizatie", "procedeu", "omologare", "rezultat"]);

  for (const k of ["teava_cc", "teava_dc"] as const) {
    const y = yearOf(meta[`${k}_data`]);
    if (y) out[`${k}_an`] = y;
  }
  // MegaConstruct: „MEDIE PRESIUNE … M.P.”, „Conducta stradală DN 250” (din teul 250/32),
  // „Nr. 209, (Nr. vechi 432) – NC 20995” (detaliile se tipăresc doar dacă există).
  const presiune = str(meta.bransament_presiune).toLowerCase();
  if (presiune) out.bransament_presiune_abr = presiune.startsWith("medie") ? "MP" : presiune.startsWith("red") ? "RP" : presiune.startsWith("joas") ? "JP" : "";
  const teu = /^\s*(\d+(?:[.,]\d+)?)\s*[-/x]/i.exec(str(meta.teu_dn));
  if (teu) out.conducta_stradala_dn = teu[1];
  out.adresa_detalii_text = filled(meta.adresa_detalii) ? `, ${str(meta.adresa_detalii)}` : "";
  const differ = str(meta.pv_date_diferite) === "da";
  for (const { key } of PV_DATES) {
    const v = differ && filled(meta[key]) ? str(meta[key]) : str(meta.pv_data);
    if (v) out[key] = v;
  }
  // RTE-ul poate fi al altei firme (NEOGAS: „Executant (RTE), ACTIVITATI DE INGINERIE…”).
  if (!filled(meta.rte_firma) && filled(meta.tenant_name)) out.rte_firma = str(meta.tenant_name);
  // Durata probelor se completează în minute; documentele o scriu „1 oră și 20 min”.
  for (const k of ["proba_rezistenta", "proba_etanseitate"] as const) {
    const text = durationText(meta[`${k}_timp`]);
    if (text) out[`${k}_durata_text`] = text;
  }
  return out;
}

/** 80 → „1 oră și 20 min”; 1445 → „24 ore și 5 min”; 45 → „45 min”; 120 → „2 ore”. */
function durationText(v: unknown): string | null {
  const m = num(v);
  if (m === null || m <= 0) return null;
  const total = Math.round(m);
  const h = Math.floor(total / 60);
  const min = total % 60;
  if (h === 0) return `${min} min`;
  const hours = h === 1 ? "1 oră" : `${h} ore`;
  return min ? `${hours} și ${min} min` : hours;
}

export interface TeamMemberLike {
  role: string;
  name: string;
  /** Din fișa angajatului; lipsesc pentru un nume scris de mână. */
  firstName?: string | null;
  lastName?: string | null;
  /** Câmpurile persoanei: `credentials` vechi ← certificări ← alocarea pe dosar. */
  creds: Record<string, string>;
  signatureS3Key?: string | null;
}

/** Câmpurile `{rol}_*` scrise pentru fiecare membru (gol dacă lipsesc). */
const ROLE_FIELDS = [
  "legitimatie",
  "legitimatie_data",
  "tip",
  "autorizatie",
  "autorizatii",
  "poanson",
  "valabilitate",
  "atestat",
  "atestat_data",
  "domeniu",
  "decizie_nr",
  "decizie_data",
] as const;

const hasPe = (c: Record<string, string>) => !!(c.autorizatie_pe_iscir || c.autorizatii_pe || c.autorizatie_pe_intern);
const hasOl = (c: Record<string, string>) => !!(c.autorizatie_ol_iscir || c.autorizatii_ol || c.autorizatie_ol_intern);

/**
 * Variabilele echipei: `{rol}_*` pentru fiecare membru, tabelul `project_sudori`
 * și `sudor_pe_*` / `sudor_ol_*` — sudorul cu certificare PE, respectiv OL; fără
 * certificări, ultimul sudor alocat (comportamentul vechi).
 */
export function teamDocVars(members: TeamMemberLike[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const sudori = members.filter((m) => m.role === "sudor");

  data.project_sudori = sudori.map((m, i) => {
    const c = m.creds;
    const pe = hasPe(c);
    const ol = hasOl(c);
    // Fără nicio certificare tipizată: rândul se completează pe ambele jumătăți, ca înainte.
    const both = !pe && !ol;
    return {
      nr_crt: String(i + 1),
      sudor_ol_nume: ol || both ? m.name : "",
      sudor_ol_aut_intern: ol || both ? c.autorizatie_ol_intern ?? (both ? c.autorizatii ?? "" : "") : "",
      sudor_ol_aut_iscir: ol || both ? c.autorizatii_ol ?? c.autorizatie_ol_iscir ?? "" : "",
      sudor_ol_poanson: ol || both ? c.poanson ?? "" : "",
      sudor_pe_nume: pe || both ? m.name : "",
      sudor_pe_aut_intern: pe || both ? c.autorizatie_pe_intern ?? (both ? c.autorizatii ?? "" : "") : "",
      sudor_pe_aut_iscir: pe || both ? c.autorizatii_pe ?? c.autorizatie_pe_iscir ?? "" : "",
      sudor_pe_poanson: pe || both ? c.poanson ?? "" : "",
    };
  });

  // „Tabel sudori autorizați”: un rând pe autorizație (sudorul PE are câte una pe procedeu).
  const split = (v: string | undefined) => (v ?? "").split(/[,;]+/).map((x) => x.trim()).filter(Boolean);
  data.sudori_autorizatii = sudori
    .flatMap((m) => {
      const auts = [...split(m.creds.autorizatii_ol ?? m.creds.autorizatie_ol_iscir), ...split(m.creds.autorizatii_pe ?? m.creds.autorizatie_pe_iscir)];
      return (auts.length ? auts : [""]).map((autorizatie) => ({ nume: m.name, autorizatie }));
    })
    .map((r, i) => ({ nr_crt: String(i + 1), ...r }));
  // Fără sudori alocați: rânduri goale, nu un tabel doar cu antetul.
  if (!sudori.length) {
    data.sudori_autorizatii = blankRows(3, ["nume", "autorizatie"]);
    data.project_sudori = blankRows(1, ["sudor_ol_nume", "sudor_ol_aut_intern", "sudor_ol_aut_iscir", "sudor_ol_poanson", "sudor_pe_nume", "sudor_pe_aut_intern", "sudor_pe_aut_iscir", "sudor_pe_poanson"]);
  }

  for (const m of members) {
    data[`${m.role}_nume`] = m.name;
    // Nume și prenume în coloane separate. Un nume scris de mână urmează ordinea de pe documente (familia întâi).
    const [family, ...given] = m.name.trim().split(/\s+/);
    data[`${m.role}_nume_familie`] = m.lastName?.trim() || (m.firstName ? "" : family ?? "");
    data[`${m.role}_prenume`] = m.firstName?.trim() || (m.lastName ? "" : given.join(" "));
    for (const f of ROLE_FIELDS) data[`${m.role}_${f}`] = m.creds[f] ?? "";
    if (m.signatureS3Key) data[`${m.role}_signature`] = { s3Key: m.signatureS3Key, mimetype: "image/png" };
  }

  if (sudori.length) {
    const last = sudori[sudori.length - 1];
    const pe = [...sudori].reverse().find((m) => hasPe(m.creds)) ?? last;
    const ol = [...sudori].reverse().find((m) => hasOl(m.creds)) ?? last;
    data.sudor_pe_nume = pe.name;
    data.sudor_pe_autorizatii = pe.creds.autorizatii_pe ?? pe.creds.autorizatie_pe_iscir ?? pe.creds.autorizatii ?? "";
    data.sudor_pe_poanson = pe.creds.poanson ?? "";
    data.sudor_pe_aut_iscir = pe.creds.autorizatie_pe_iscir ?? "";
    data.sudor_pe_aut_data = pe.creds.autorizatie_pe_data ?? "";
    data.sudor_ol_nume = ol.name;
    data.sudor_ol_autorizatii = ol.creds.autorizatii_ol ?? ol.creds.autorizatie_ol_iscir ?? ol.creds.autorizatii ?? "";
    data.sudor_ol_poanson = ol.creds.poanson ?? "";
    data.sudor_ol_aut_iscir = ol.creds.autorizatie_ol_iscir ?? "";
    data.sudor_ol_aut_data = ol.creds.autorizatie_ol_data ?? "";
  }
  return data;
}
