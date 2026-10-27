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
 * - `suduri[]` + `total_suduri` din `suduri_lista` („S79, S80, S81”).
 */
export function derivedDossierVars(meta: Meta): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!filled(meta.bransament_lungime_totala)) {
    const len = num(meta.project_length);
    const reiser = num(meta.bransament_lungime_reiser);
    if (len !== null && reiser !== null) {
      const d = Math.max(decimals(meta.project_length), decimals(meta.bransament_lungime_reiser));
      out.bransament_lungime_totala = (len + reiser).toFixed(d);
    }
  }
  const codes = str(meta.suduri_lista)
    .split(/[,;\n]+/)
    .map((c) => c.trim())
    .filter(Boolean);
  out.suduri = codes.map((cod, i) => ({ nr_crt: String(i + 1), cod, rezultat: "ADMIS" }));
  out.total_suduri = codes.length ? String(codes.length) : "";
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

  for (const m of members) {
    data[`${m.role}_nume`] = m.name;
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
