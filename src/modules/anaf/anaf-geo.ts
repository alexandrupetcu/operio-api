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
