/**
 * Normalizarea răspunsului de la citirea documentelor atașate la dosar (vezi
 * `modules/dossiers/attachment-read.ts`) — pură, fără rețea, ca să se poată testa.
 */
export type MaterialDocKind = "factura" | "certificat_calitate" | "declaratie_conformitate" | "aviz" | "altul";

export interface MaterialDocData {
  tip: MaterialDocKind;
  furnizor?: string;
  lot?: string;
  certificat?: { nr: string; data?: string };
  declaratie?: { nr: string; data?: string };
  factura?: { nr: string; data?: string };
  aviz?: { denumire?: string; emitent?: string; nr?: string; data?: string };
  materiale: { denumire: string; diametru?: string; cantitate?: string }[];
}

const KINDS: MaterialDocKind[] = ["factura", "certificat_calitate", "declaratie_conformitate", "aviz"];
const s = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "");

/** „2025-07-24” / „24/07/2025” / „3.1.2025” → „24.07.2025”; altfel textul așa cum e. */
function roDate(v: unknown): string {
  const t = s(v);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return `${m[3].padStart(2, "0")}.${m[2].padStart(2, "0")}.${m[1]}`;
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(t);
  if (m) return `${m[1].padStart(2, "0")}.${m[2].padStart(2, "0")}.${m[3]}`;
  return t;
}

const numbered = (v: unknown): { nr: string; data?: string } | undefined => {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const nr = s(o.nr);
  if (!nr) return undefined;
  const data = roDate(o.data);
  return data ? { nr, data } : { nr };
};

/** „63 mm” / „Dn 63” / „Ø63” → „63”; „2”” rămâne. */
const dn = (v: unknown) => s(v).replace(/^(?:dn|ø|d)\s*/i, "").replace(/\s*mm$/i, "");

export function normalizeMaterialDoc(raw: unknown): MaterialDocData {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const tip = KINDS.includes(o.tip_document as MaterialDocKind) ? (o.tip_document as MaterialDocKind) : "altul";
  const out: MaterialDocData = { tip, materiale: [] };
  if (s(o.furnizor)) out.furnizor = s(o.furnizor);
  if (s(o.lot)) out.lot = s(o.lot);
  const cc = numbered(o.certificat_calitate);
  if (cc) out.certificat = cc;
  const dc = numbered(o.declaratie_conformitate);
  if (dc) out.declaratie = dc;
  const fa = numbered(o.factura);
  if (fa) out.factura = fa;
  if (o.aviz && typeof o.aviz === "object") {
    const a = o.aviz as Record<string, unknown>;
    const aviz = Object.fromEntries(
      Object.entries({ denumire: s(a.denumire), emitent: s(a.emitent), nr: s(a.nr), data: roDate(a.data) }).filter(([, v]) => v),
    );
    if (Object.keys(aviz).length) out.aviz = aviz;
  }
  if (Array.isArray(o.materiale)) {
    for (const m of o.materiale as Record<string, unknown>[]) {
      const denumire = s(m?.denumire);
      if (!denumire) continue;
      const row: MaterialDocData["materiale"][number] = { denumire };
      if (dn(m.diametru)) row.diametru = dn(m.diametru);
      const q = [s(m.cantitate), s(m.um)].filter(Boolean).join(" ");
      if (q) row.cantitate = q;
      out.materiale.push(row);
    }
  }
  return out;
}

