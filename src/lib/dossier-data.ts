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
  /** Variante propuse în pagina Dosare (ex. tipurile de fitinguri). */
  options?: string[];
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
  materiale_conducta: {
    itemLabel: "material",
    columns: MATERIAL_COLUMNS,
    rows: [
      "Material tubular PE",
      "Mufe EF",
      "Dopuri EF",
      "Coturi EF",
      "Teu egal EF",
      "Răsuflători",
      "Capace GN",
      "Fir trasor",
      "Bandă avertizare „pericol explozie”",
      "Nisip",
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
  tronsoane: {
    itemLabel: "tronson",
    columns: [
      { key: "comuna", label: "Localitatea / comuna" },
      { key: "strada", label: "Strada" },
      { key: "de_la", label: "De la (ex. nr. 25C)" },
      { key: "pana_la", label: "Până la (ex. conducta existentă)" },
      { key: "dn", label: "Diametru (mm; la OL în ″)" },
      { key: "material", label: "Material (ex. PE100 SDR11)" },
      { key: "lungime", label: "Lungime (m)" },
      { key: "data", label: "Data execuției (etapa)" },
    ],
  },
  schita_materiale: {
    itemLabel: "material",
    columns: [
      { key: "descriere", label: "Descriere (ex. Țeavă, Mufă EF)" },
      { key: "dimensiune", label: "Dimensiune (ex. Dn 63mm)" },
      { key: "material", label: "Material (ex. PE 100)" },
      { key: "cantitate", label: "Cantitate (buc / ml)" },
    ],
    rows: ["Țeavă", "Mufă EF", "Dop", "Șa EF", "Vană", "Capac carosabil", "Tub de protecție"],
  },
  fitinguri_pe: {
    itemLabel: "fiting PE",
    columns: [
      { key: "tip", label: "Fitingul", options: [] as string[] },
      { key: "dn", label: "Dn (mm sau Dn-Dn)" },
      { key: "buc", label: "Bucăți" },
    ],
  },
  fitinguri_ol: {
    itemLabel: "material OL",
    columns: [
      { key: "tip", label: "Materialul", options: [] as string[] },
      { key: "dn", label: "Dn / dimensiune" },
      { key: "cantitate", label: "Cantitate (buc / ml)" },
    ],
  },
  terasamente: {
    itemLabel: "operațiune",
    columns: [
      { key: "operatiune", label: "Operațiunea" },
      { key: "lungime", label: "Șanț L (m)" },
      { key: "latime", label: "Șanț l (m)" },
      { key: "spatiu_verde", label: "Spațiu verde" },
      { key: "pietris", label: "Pietriș" },
      { key: "macadam", label: "Piatră spartă / macadam" },
      { key: "pavele", label: "Pavele / dale" },
      { key: "asfalt_carosabil", label: "Asfalt carosabil" },
      { key: "asfalt_trotuar", label: "Asfalt trotuar" },
      { key: "beton", label: "Beton" },
    ],
    rows: ["Săpătură șanț conductă", "Așternere nisip (ml)", "Tăiere (ml)", "Desfacere (mp)", "Refacere (mp)"],
  },
  subtraversari: {
    itemLabel: "subtraversare",
    columns: [
      { key: "descriere", label: "Ce se subtraversează (ex. Str. Unirii)" },
      { key: "material", label: "Tubul de protecție (ex. PE100 SDR26)" },
      { key: "dn", label: "Diametru (mm)" },
      { key: "lungime", label: "Lungime (m)" },
      { key: "adancime", label: "Adâncime (ex. -1,40 m)" },
    ],
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
  { key: "pv_proba_casa_data", label: "PV probă de casă" },
  { key: "pv_tub_protectie_data", label: "PV de lucrări ascunse — tub de protecție" },
  { key: "pv_receptie_calitativa_data", label: "PV de recepție calitativă a montării" },
];

/** Tipurile din Anexa 25 MegaConstruct (coloanele formularului), în ordinea lor. */
export const FITINGURI_PE = ["Vană PEHD", "Mufă EF", "Reducție injectat", "Reducție electrofuziune", "Cot injectat", "Cot electrofuziune", "Teu egal injectat", "Teu egal electrofuziune", "Teu redus injectat", "Teu redus electrofuziune", "Șa branșament", "Capac EF"];
export const FITINGURI_OL = ["Vană OL", "Curbă sudură", "Reducție OL", "Fiting tranziție OL-PE", "Bandă izolație Kebulen", "Răsuflător spațiu verde", "Răsuflător carosabil", "Capac GN", "Capac GN mare", "Fir trasor", "Bandă avertizare"];
DOSSIER_TABLES.fitinguri_pe.columns[0].options = FITINGURI_PE;
DOSSIER_TABLES.fitinguri_ol.columns[0].options = FITINGURI_OL;

/** „Șa branșament” → „sa_bransament” (cheia variabilelor din Anexa 25). */
export const slugOf = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/** Fitingurile pe tip: la PE câte două rânduri pe tip (`fpe_<tip>_<1|2>_dn/_buc`), la OL unul (`fol_<tip>_dn/_q`). */
function fitinguriVars(meta: Meta): Record<string, string> {
  const out: Record<string, string> = {};
  const pe = parseDossierTable(DOSSIER_TABLES.fitinguri_pe, meta.fitinguri_pe);
  for (const tip of FITINGURI_PE) {
    const rows = pe.filter((r) => slugOf(r.tip) === slugOf(tip));
    for (const i of [1, 2]) {
      out[`fpe_${slugOf(tip)}_${i}_dn`] = rows[i - 1]?.dn ?? "";
      out[`fpe_${slugOf(tip)}_${i}_buc`] = rows[i - 1]?.buc ?? "";
    }
  }
  const ol = parseDossierTable(DOSSIER_TABLES.fitinguri_ol, meta.fitinguri_ol);
  for (const tip of FITINGURI_OL) {
    const r = ol.find((x) => slugOf(x.tip) === slugOf(tip));
    out[`fol_${slugOf(tip)}_dn`] = r?.dn ?? "";
    out[`fol_${slugOf(tip)}_q`] = r?.cantitate ?? "";
  }
  return out;
}

/** Diametrele PE tipărite ca coloane în anexele cu tronsoane (ex. Ø90 / Ø63 / Ø32). */
const STANDARD_DN = ["20", "25", "32", "40", "50", "63", "75", "90", "110", "125", "160", "180", "200", "225", "250", "315"];
const dnKey = (dn: string) => {
  const t = dn.trim().replace(",", ".");
  const ol = /["″”]|toli|^(\d+(?:\.\d+)?)\s*(?:in|inch)$/i.test(t);
  const n = /\d+(?:\.\d+)?/.exec(t)?.[0];
  return n ? (ol ? `ol_${n.replace(".", "_")}` : n.replace(".", "_")) : null;
};

/** Suma unor lungimi, cu zecimalele celui mai precis termen („60.30” + „18.50” → „78.80”). */
function sumLengths(values: unknown[]): string | null {
  const nums = values.map(num);
  if (!nums.length || nums.some((n) => n === null)) return null;
  const d = Math.max(...values.map(decimals));
  return (nums as number[]).reduce((a, b) => a + b, 0).toFixed(d);
}

/**
 * Tronsoanele conductei: rândurile (cu `ldn_<Ø>` = lungimea în coloana diametrului lui),
 * lungimea totală, lungimile pe diametre (`lungimi_dn[]`, `lungime_dn_63`, `lungime_dn_ol_2`).
 * Fără tronsoane, un singur tronson din datele lucrării (strada, Dn, lungimea).
 */
function tronsoaneVars(meta: Meta): Record<string, unknown> {
  let rows = parseDossierTable(DOSSIER_TABLES.tronsoane, meta.tronsoane);
  if (!filled(meta.tronsoane) && filled(meta.project_length)) {
    rows = [{
      nr_crt: "1",
      comuna: str(meta.project_city),
      strada: str(meta.project_street) || str(meta.lucrare_strada),
      de_la: "",
      pana_la: "",
      dn: str(meta.project_dn),
      material: str(meta.project_material),
      lungime: str(meta.project_length),
      data: "",
    }];
  }
  if (!rows.length) return {};
  const out: Record<string, unknown> = {};
  const byDn = new Map<string, unknown[]>();
  for (const r of rows) {
    const k = dnKey(r.dn);
    for (const d of STANDARD_DN) r[`ldn_${d}`] = k === d ? r.lungime : "";
    if (k) byDn.set(r.dn.trim(), [...(byDn.get(r.dn.trim()) ?? []), r.lungime]);
  }
  out.tronsoane = rows;
  // „Tronson Dn 63 mm, L=60.30 ml, între Str. Unirii nr. 25C și conducta existentă; …”
  out.tronsoane_text = rows
    .map((r) => {
      const ends = [r.de_la ? `${r.strada} ${r.de_la}`.trim() : "", r.pana_la].filter(Boolean);
      const where = ends.length === 2 ? `între ${ends[0]} și ${ends[1]}` : ends[0] || r.strada;
      return [`Tronson Dn ${r.dn} mm, L=${r.lungime} ml`, where].filter(Boolean).join(", ");
    })
    .join("; ");
  const lungimi = [...byDn].map(([dn, ls]) => ({ dn, lungime: sumLengths(ls) ?? "" }));
  out.lungimi_dn = lungimi;
  for (const d of STANDARD_DN) out[`lungime_dn_${d}`] = "";
  for (const l of lungimi) {
    const k = dnKey(l.dn);
    if (k) out[`lungime_dn_${k}`] = l.lungime;
  }
  out.conducta_dn_lungimi_text = lungimi.map((l) => `Dn ${l.dn} mm = ${l.lungime} m`).join(", ");
  // „Dn 63/90 mm” — toate diametrele, acolo unde formularul are un singur Dn.
  out.conducta_dn_text = lungimi.map((l) => l.dn).join("/");
  // Fișa tehnică Distrigaz are două coloane de tronson (diametru / lungime); a doua „-” dacă nu există.
  for (const i of [1, 2]) {
    out[`dn_${i}`] = lungimi[i - 1]?.dn ?? "-";
    out[`lungime_${i}`] = lungimi[i - 1]?.lungime ?? "-";
  }
  const total = sumLengths(rows.map((r) => r.lungime));
  if (total !== null) out.conducta_lungime_totala = total;
  const isOl = (r: Record<string, string>) => (dnKey(r.dn) ?? "").startsWith("ol_");
  out.lungime_total_pe = sumLengths(rows.filter((r) => !isOl(r)).map((r) => r.lungime)) ?? "";
  out.lungime_total_ol = sumLengths(rows.filter(isOl).map((r) => r.lungime)) ?? "";
  // Etapele (MegaConstruct): tronsoanele grupate pe data execuției; PV-urile de șantier se repetă pe etapă.
  const groups = new Map<string, Record<string, string>[]>();
  for (const r of rows) groups.set(r.data.trim(), [...(groups.get(r.data.trim()) ?? []), r]);
  const many = groups.size > 1;
  out.etape = [...groups].map(([data, rs], i) => {
    const e: Record<string, string> = {
      nr_etapa: String(i + 1),
      sufix: many ? `-${i + 1}` : "",
      data,
      lungime_etapa: sumLengths(rs.map((r) => r.lungime)) ?? "",
      dn_etapa: [...new Set(rs.map((r) => r.dn.trim()).filter(Boolean))].join("/"),
      tronsoane_etapa_text: rs.map((r) => `Tronson Dn ${r.dn} mm, L=${r.lungime} ml${r.strada ? `, ${r.strada}` : ""}`).join("; "),
    };
    // În buclă, datele PV-urilor de șantier sunt data etapei (dacă tronsoanele au dată).
    for (const { key } of PV_DATES) e[key] = data || str(meta[key]) || str(meta.pv_data);
    return e;
  });
  return out;
}

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
    if (!["suduri_tabel", "tronsoane", "subtraversari", "fitinguri_pe", "fitinguri_ol"].includes(key)) out[key] = parseDossierTable(table, meta[key]);
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
  out.suduri_coduri_text = (out.suduri as { cod: string }[]).map((r) => r.cod).filter(Boolean).join(", ");
  if (!filled(meta.lucrare_tip)) out.lucrare_tip = "Extindere conductă";
  out.total_suduri = n ? String(n) : "";
  Object.assign(out, tronsoaneVars({ ...meta, ...out }));
  out.documente_materiale_linii = str(meta.documente_materiale)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((text) => ({ text }));
  out.subtraversari = parseDossierTable(DOSSIER_TABLES.subtraversari, meta.subtraversari);
  Object.assign(out, fitinguriVars(meta));
  // Proba de casă: implicit presiunea și durata probei de rezistență.
  if (!filled(meta.proba_casa_presiune) && !filled(meta.proba_casa_timp)) {
    if (filled(meta.proba_rezistenta_presiune)) out.proba_casa_presiune = str(String(meta.proba_rezistenta_presiune));
    const t = durationText(meta.proba_rezistenta_timp);
    if (t) out.proba_casa_durata_text = t;
  } else {
    const t = durationText(meta.proba_casa_timp);
    if (t) out.proba_casa_durata_text = t;
  }
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
    if (m.signatureS3Key) {
      data[`${m.role}_signature`] = { s3Key: m.signatureS3Key, mimetype: "image/png" };
      // Varianta mică, în rândul tabelului (celula „Semnatura” din PV-uri), nu peste text.
      data[`${m.role}_signature_mic`] = { s3Key: m.signatureS3Key, mimetype: "image/png" };
    }
  }

  if (sudori.length) {
    const last = sudori[sudori.length - 1];
    const pe = [...sudori].reverse().find((m) => hasPe(m.creds)) ?? last;
    const ol = [...sudori].reverse().find((m) => hasOl(m.creds)) ?? last;
    data.sudor_pe_nume = pe.name;
    if (pe.signatureS3Key) data.sudor_pe_signature_mic = { s3Key: pe.signatureS3Key, mimetype: "image/png" };
    data.sudor_pe_autorizatii = pe.creds.autorizatii_pe ?? pe.creds.autorizatie_pe_iscir ?? pe.creds.autorizatii ?? "";
    data.sudor_pe_poanson = pe.creds.poanson ?? "";
    data.sudor_pe_aut_iscir = pe.creds.autorizatie_pe_iscir ?? "";
    data.sudor_pe_aut_data = pe.creds.autorizatie_pe_data ?? "";
    data.sudor_ol_nume = ol.name;
    if (ol.signatureS3Key) data.sudor_ol_signature_mic = { s3Key: ol.signatureS3Key, mimetype: "image/png" };
    data.sudor_ol_autorizatii = ol.creds.autorizatii_ol ?? ol.creds.autorizatie_ol_iscir ?? ol.creds.autorizatii ?? "";
    data.sudor_ol_poanson = ol.creds.poanson ?? "";
    data.sudor_ol_aut_iscir = ol.creds.autorizatie_ol_iscir ?? "";
    data.sudor_ol_aut_data = ol.creds.autorizatie_ol_data ?? "";
  }
  return data;
}
