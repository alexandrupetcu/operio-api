import type { FastifyInstance } from "fastify";
import { searchCities, searchStates } from "./geography.service.js";
import { z } from "zod";

const searchSchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const BUCURESTI_STATE_ID = 4730;
const ROMANIA_COUNTRY_ID = 181;
const GEO_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Tiny in-memory TTL cache for the public /resolve-anaf route: the full state
 * list and the per-county city lists are static, so don't hit the DB on every
 * (unauthenticated) call.
 */
const geoCache = new Map<string, { expiresAt: number; value: unknown }>();
async function cachedFor<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const hit = geoCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const value = await loader();
  geoCache.set(key, { expiresAt: Date.now() + ttlMs, value });
  return value;
}

/**
 * Strip Romanian diacritics entirely for fuzzy matching.
 * Both ANAF and the dr5hn dataset use inconsistent Unicode variants
 * (cedilla vs comma-below for Ș/Ț), so we strip to ASCII for comparison.
 */
function stripRomanianDiacritics(str: string): string {
  return str
    .replace(/[\u0218\u015E]/g, "S") // Ș, Ş → S
    .replace(/[\u0219\u015F]/g, "s") // ș, ş → s
    .replace(/[\u021A\u0162]/g, "T") // Ț, Ţ → T
    .replace(/[\u021B\u0163]/g, "t") // ț, ţ → t
    .replace(/[\u0102]/g, "A")       // Ă → A
    .replace(/[\u0103]/g, "a")       // ă → a
    .replace(/[\u00C2]/g, "A")       // Â → A
    .replace(/[\u00E2]/g, "a")       // â → a
    .replace(/[\u00CE]/g, "I")       // Î → I
    .replace(/[\u00EE]/g, "i");      // î → i
}

/**
 * Normalize ANAF county name to match our DB names.
 * ANAF returns e.g. "MUNICIPIUL BUCUREȘTI", "IAȘI", "CLUJ"
 */
function normalizeAnafCounty(raw: string): string {
  let name = raw.trim();
  // Remove common prefixes (use stripped version for regex matching)
  name = name.replace(/^MUNICIPIUL\s+/i, "");
  const stripped = stripRomanianDiacritics(name);
  if (/^JUDETUL\s+/i.test(stripped)) {
    name = name.slice(stripped.match(/^JUDETUL\s+/i)![0].length);
  }
  return name;
}

/**
 * Normalize ANAF city/localitate name.
 * ANAF returns e.g. "Sector 5 Mun București", "CLUJ-NAPOCA", "Brașov"
 * For București sectors: extract "Sector X"
 */
function normalizeAnafCity(raw: string, isBucuresti: boolean): string {
  let name = raw.trim();
  if (isBucuresti) {
    const sectorMatch = name.match(/sector(?:ul)?\s*(\d)/i);
    if (sectorMatch) {
      return `Sector ${sectorMatch[1]}`;
    }
  }
  // Remove common prefixes
  name = name.replace(/^MUN(?:ICIPIUL)?\s+/i, "");
  name = name.replace(/^COMUNA\s+/i, "");
  name = name.replace(/^SAT(?:UL)?\s+/i, "");
  const stripped = stripRomanianDiacritics(name);
  if (/^ORAS(?:UL)?\s+/i.test(stripped)) {
    name = name.slice(stripped.match(/^ORAS(?:UL)?\s+/i)![0].length);
  }
  return name;
}

export default async function geographyRoutes(fastify: FastifyInstance) {
  // No auth required — geography data is public/shared

  // GET /countries
  fastify.get("/countries", async (request) => {
    const { q, limit } = searchSchema.parse(request.query);
    return fastify.prisma.country.findMany({
      where: q
        ? { name: { contains: q, mode: "insensitive" } }
        : undefined,
      select: { id: true, name: true, iso2: true, emoji: true },
      orderBy: { name: "asc" },
      take: limit,
    });
  });

  // GET /countries/:countryId/states
  fastify.get<{ Params: { countryId: string } }>(
    "/countries/:countryId/states",
    async (request) => {
      const countryId = parseInt(request.params.countryId, 10);
      if (isNaN(countryId)) throw fastify.httpErrors.badRequest("Invalid country ID");

      const { q, limit } = searchSchema.parse(request.query);
      return searchStates(fastify.prisma, countryId, q, limit);
    }
  );

  // GET /states/:stateId/cities
  fastify.get<{ Params: { stateId: string } }>(
    "/states/:stateId/cities",
    async (request) => {
      const stateId = parseInt(request.params.stateId, 10);
      if (isNaN(stateId)) throw fastify.httpErrors.badRequest("Invalid state ID");

      const { q, limit } = searchSchema.parse(request.query);
      return searchCities(fastify.prisma, stateId, q, limit);
    }
  );

  // POST /resolve-anaf — resolve ANAF county+city names to geography IDs
  const resolveSchema = z.object({
    judet: z.string().min(1),
    localitate: z.string().optional(),
  });

  // Public (no auth) → rate-limited, and the state/city lists are cached in memory.
  fastify.post("/resolve-anaf", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request) => {
    const { judet, localitate } = resolveSchema.parse(request.body);

    const normalizedCounty = normalizeAnafCounty(judet);
    const strippedCounty = stripRomanianDiacritics(normalizedCounty).toLowerCase();

    // Load all Romanian states (cached) and match using stripped diacritics
    const allStates = await cachedFor(`states:${ROMANIA_COUNTRY_ID}`, GEO_CACHE_TTL_MS, () =>
      fastify.prisma.state.findMany({
        where: { countryId: ROMANIA_COUNTRY_ID },
        select: { id: true, name: true },
      }),
    );

    const state = allStates.find(
      (s) => stripRomanianDiacritics(s.name).toLowerCase() === strippedCounty
    ) ?? null;

    if (!state) {
      return { state: null, city: null };
    }

    let city = null;
    if (localitate) {
      const isBucuresti = state.id === BUCURESTI_STATE_ID;
      const normalizedCity = normalizeAnafCity(localitate, isBucuresti);
      const strippedCity = stripRomanianDiacritics(normalizedCity).toLowerCase();

      // Load all cities for this state (cached) and match using stripped diacritics
      const allCities = await cachedFor(`cities:${state.id}`, GEO_CACHE_TTL_MS, () =>
        fastify.prisma.city.findMany({
          where: { stateId: state.id },
          select: { id: true, name: true },
        }),
      );

      // Exact match first
      city = allCities.find(
        (c) => stripRomanianDiacritics(c.name).toLowerCase() === strippedCity
      ) ?? null;

      // Fallback: partial match (DB name contains search term)
      if (!city) {
        city = allCities.find(
          (c) => stripRomanianDiacritics(c.name).toLowerCase().includes(strippedCity)
        ) ?? null;
      }
    }

    return { state, city };
  });
}
