import type { PrismaClient } from "@prisma/client";

/**
 * Map ANAF's registered-office fields (county + locality, uppercase, cedilla
 * diacritics, "MUNICIPIUL …" prefixes) onto our geography tables so a firm's
 * profile gets real country/county/city ids instead of free text.
 */
export interface MatchedLocation {
  countryId: number;
  stateId: number | null;
  stateName: string | null;
  cityId: number | null;
  cityName: string | null;
}

// ANAF abbreviations: "Orş. Voluntari", "Mun. Ploieşti", "Com. Berceni", "Sat Tunari"
const PREFIXES = /^(municipiul|municipiu|mun\.?|orasul|oras|ors\.?|or\.?|comuna|com\.?|satul|sat|sectorul)\s+/;

/** "MUNICIPIUL BUCUREŞTI" → "bucuresti"; "Orş. Voluntari" → "voluntari"; "Sector 5 Mun. Bucureşti" → "sector 5". */
export function normalizePlace(v: string): string {
  let s = v
    .toLowerCase()
    .replace(/[şș]/g, "s").replace(/[ţț]/g, "t")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sector = s.match(/\bsector(?:ul)?\s*(\d)\b/);
  if (sector) return `sector ${sector[1]}`;
  s = s.replace(PREFIXES, "").trim();
  // "voluntari jud. ilfov" / "ploiesti mun." — drop trailing qualifiers
  return s.replace(/\s+(jud\.?|judetul|mun\.?|municipiul)\b.*$/, "").trim();
}

export async function matchAnafLocation(
  prisma: PrismaClient,
  sediu: { judet: string; localitate: string },
): Promise<MatchedLocation | null> {
  const ro = await prisma.country.findFirst({ where: { iso2: "RO" }, select: { id: true } });
  if (!ro) return null;
  const result: MatchedLocation = { countryId: ro.id, stateId: null, stateName: null, cityId: null, cityName: null };

  const judet = normalizePlace(sediu.judet);
  if (!judet) return result;
  // Small list (42 counties) — compare normalized in memory rather than relying on DB collation.
  const states = await prisma.state.findMany({ where: { countryId: ro.id }, select: { id: true, name: true } });
  const state = states.find((s) => normalizePlace(s.name) === judet) ?? states.find((s) => normalizePlace(s.name).startsWith(judet));
  if (!state) return result;
  result.stateId = state.id;
  result.stateName = state.name;

  const loc = normalizePlace(sediu.localitate);
  if (!loc) return result;
  const cities = await prisma.city.findMany({ where: { stateId: state.id }, select: { id: true, name: true } });
  const city =
    cities.find((c) => normalizePlace(c.name) === loc) ??
    // "Bucuresti" registered office without a sector, or county seat spelled slightly differently
    cities.find((c) => normalizePlace(c.name) === judet && loc.includes(judet)) ??
    cities.find((c) => loc.startsWith(normalizePlace(c.name)) || normalizePlace(c.name).startsWith(loc));
  if (city) {
    result.cityId = city.id;
    result.cityName = city.name;
  }
  return result;
}

/** "ŞOS. BUCUREŞTI NORD" → "Șos. București Nord"; unit tokens (nr./bl./sc./ap.) stay lower-case mid-segment, codes like P3/O11 upper. */
export function titleCaseRo(v: string): string {
  let t = v
    .toLowerCase()
    .replace(/ş/g, "ș").replace(/ţ/g, "ț")
    .replace(/\b(nr|bl|sc|et|ap|cam)(?:\.|\s+|(?=\d))\s*(?=[a-z0-9])/g, "$1. ") // "NR.2" → "nr. 2", "BL.P3" → "bl. P3" (not "bld", "etajele")
    .replace(/(^|[\s.,/(-])([a-zăâîșț])/g, (_, pre, ch) => pre + ch.toUpperCase())
    .replace(/\b(Nr|Bl|Sc|Et|Ap|Cam)\.(?=\s)/g, (m) => m.toLowerCase())
    .replace(/\b([a-zA-Z])(\d+)\b/g, (_, l, d) => l.toUpperCase() + d)        // P3, O11
    .replace(/\s+/g, " ")
    .trim();
  // Each comma-separated segment starts with a capital ("Str.", "Parter")
  return t.split(",").map((seg) => seg.trim().replace(/^([a-zăâîșț])/, (c) => c.toUpperCase())).join(", ");
}

/**
 * Street-level address only (no county / locality): "Str. Moțoc nr. 2, Parter, bl. P3, sc. 3, ap. 56".
 * Works on ANAF's one-line `adresa` (its structured fields drop building details) by removing the
 * leading county / locality / sector segments.
 */
export function streetAddress(adresa: string): string {
  const segs = adresa.split(",").map((s) => s.trim()).filter(Boolean);
  const isPlace = (s: string) => {
    const n = normalizePlace(s);
    return /^sector \d$/.test(n) || /^(jud\.?|judetul|municipiul|mun\.?|ors\.?|orasul|oras|com\.?|comuna|sat)\b/i.test(s.toLowerCase().replace(/[şș]/g, "s").replace(/[ţț]/g, "t"));
  };
  while (segs.length > 1 && isPlace(segs[0])) segs.shift();
  return titleCaseRo(segs.join(", "));
}

/**
 * Romanian CUI check digit (weights 7 5 3 2 1 7 5 3 2 over the leading digits, ×10 mod 11, 10→0).
 * Catches most typos before we ask ANAF — a truncated/typo'd number can still be *someone else's* valid CUI.
 */
export function isValidCui(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 2 || digits.length > 10) return false;
  const d = digits.split("").map(Number);
  const weights = [7, 5, 3, 2, 1, 7, 5, 3, 2].slice(-(d.length - 1));
  const sum = weights.reduce((acc, w, i) => acc + w * d[i], 0);
  let control = (sum * 10) % 11;
  if (control === 10) control = 0;
  return control === d[d.length - 1];
}
