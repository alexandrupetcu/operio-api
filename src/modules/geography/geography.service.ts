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
