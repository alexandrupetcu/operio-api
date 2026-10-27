import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * Căutarea județelor / localităților, insensibilă la diacritice și la majuscule:
 * pe teren se tastează „timis”, „iasi”, nu „Timiș”, „Iași”. Comparația se face
 * în SQL, pe `translate(lower(name))`, ca să nu aducem toate rândurile în Node;
 * nu depinde de extensia `unaccent`.
 */
const DIACRITICS = "ăâîșțşţ";
const PLAIN = "aaistst";

/** Textul căutat, fără diacritice, cu jokerii LIKE scăpați. */
export function foldSearchTerm(q: string): string {
  let out = q.normalize("NFC").toLowerCase().trim();
  for (let i = 0; i < DIACRITICS.length; i++) out = out.split(DIACRITICS[i]).join(PLAIN[i]);
  return out.replace(/[\\%_]/g, (c) => `\\${c}`);
}

type NamedRow = { id: number; name: string };

// Și ordonarea e pe numele „pliat”: altfel, după colația bazei, „Șag” ar veni după „Timișoara”.
const folded = Prisma.sql`translate(lower(name), ${DIACRITICS}, ${PLAIN})`;
const matches = (q: string | undefined) => (q?.trim() ? Prisma.sql`AND ${folded} LIKE ${`%${foldSearchTerm(q)}%`} ESCAPE '\\'` : Prisma.empty);

export async function searchStates(prisma: PrismaClient, countryId: number, q: string | undefined, limit: number) {
  return prisma.$queryRaw<Array<NamedRow & { stateCode: string | null }>>(Prisma.sql`
    SELECT id, name, "stateCode"
    FROM "State"
    WHERE "countryId" = ${countryId} ${matches(q)}
    ORDER BY ${folded} ASC, name ASC
    LIMIT ${limit}
  `);
}

export async function searchCities(prisma: PrismaClient, stateId: number, q: string | undefined, limit: number) {
  return prisma.$queryRaw<NamedRow[]>(Prisma.sql`
    SELECT id, name
    FROM "City"
    WHERE "stateId" = ${stateId} ${matches(q)}
    ORDER BY ${folded} ASC, name ASC
    LIMIT ${limit}
  `);
}

export interface CountryPack {
  countryId: number;
  generatedAt: string;
  states: Array<{ id: number; name: string; stateCode: string | null; cities: NamedRow[] }>;
}

/**
 * Toate județele unei țări cu localitățile lor, într-un singur răspuns: telefonul
 * îl ține local ca selectorul de adresă să meargă și fără semnal (România ≈ 7 900
 * de localități, ~270 KB). Ordonate pe numele pliat, ca listele de căutare.
 */
export async function countryPack(prisma: PrismaClient, countryId: number): Promise<CountryPack> {
  const states = await prisma.$queryRaw<Array<NamedRow & { stateCode: string | null }>>(Prisma.sql`
    SELECT id, name, "stateCode" FROM "State" WHERE "countryId" = ${countryId} ORDER BY ${folded} ASC, name ASC
  `);
  const cities = await prisma.$queryRaw<Array<NamedRow & { stateId: number }>>(Prisma.sql`
    SELECT id, name, "stateId" FROM "City" WHERE "countryId" = ${countryId} ORDER BY ${folded} ASC, name ASC
  `);
  const byState = new Map<number, NamedRow[]>();
  for (const c of cities) {
    const list = byState.get(c.stateId) ?? [];
    list.push({ id: c.id, name: c.name });
    byState.set(c.stateId, list);
  }
  return {
    countryId,
    generatedAt: new Date().toISOString(),
    states: states.map((s) => ({ ...s, cities: byState.get(s.id) ?? [] })),
  };
}
