import { PrismaClient } from "@prisma/client";
import { createWriteStream } from "fs";
import { readFile, unlink } from "fs/promises";
import { createGunzip } from "zlib";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

const prisma = new PrismaClient();

const BASE_URL =
  "https://raw.githubusercontent.com/dr5hn/countries-states-cities-database/master/json";

async function downloadJson(filename: string): Promise<unknown> {
  console.log(`Downloading ${filename}...`);
  const res = await fetch(`${BASE_URL}/${filename}`);
  if (!res.ok) throw new Error(`Failed to download ${filename}: ${res.status}`);
  return res.json();
}

async function downloadGzipJson(filename: string): Promise<unknown> {
  console.log(`Downloading ${filename} (gzipped)...`);
  const res = await fetch(`${BASE_URL}/${filename}`);
  if (!res.ok) throw new Error(`Failed to download ${filename}: ${res.status}`);

  const tmpPath = `/tmp/${filename.replace(".gz", "")}`;
  const gunzip = createGunzip();
  const fileStream = createWriteStream(tmpPath);

  await pipeline(
    Readable.fromWeb(res.body as import("stream/web").ReadableStream),
    gunzip,
    fileStream
  );

  const data = JSON.parse(await readFile(tmpPath, "utf-8"));
  await unlink(tmpPath);
  return data;
}

interface RawCountry {
  id: number;
  name: string;
  iso3: string;
  iso2: string;
  numeric_code: string | null;
  phonecode: string | null;
  capital: string | null;
  currency: string | null;
  currency_name: string | null;
  currency_symbol: string | null;
  tld: string | null;
  native: string | null;
  region: string | null;
  subregion: string | null;
  nationality: string | null;
  latitude: string | null;
  longitude: string | null;
  emoji: string | null;
  emojiU: string | null;
}

interface RawState {
  id: number;
  name: string;
  country_id: number;
  country_code: string;
  state_code: string | null;
  type: string | null;
  latitude: string | null;
  longitude: string | null;
}

interface RawCity {
  id: number;
  name: string;
  state_id: number;
  country_id: number;
  country_code: string;
  state_code: string | null;
  latitude: string | null;
  longitude: string | null;
}

const BATCH_SIZE = 5000;

async function batchInsert<T>(
  label: string,
  items: T[],
  insertFn: (batch: T[]) => Promise<void>
) {
  console.log(`Inserting ${items.length} ${label}...`);
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    await insertFn(batch);
    console.log(
      `  ${label}: ${Math.min(i + BATCH_SIZE, items.length)}/${items.length}`
    );
  }
}

function parseCoord(val: string | null): number | null {
  if (!val || val === "") return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

async function main() {
  console.log("Starting geographic data import...\n");

  // Check if data already exists
  const countryCount = await prisma.country.count();
  if (countryCount > 0) {
    console.log(
      `Database already has ${countryCount} countries. Clearing existing data...`
    );
    // Delete in order due to FK constraints
    await prisma.city.deleteMany();
    await prisma.state.deleteMany();
    await prisma.country.deleteMany();
    console.log("Cleared existing geographic data.\n");
  }

  // Download data
  const [countriesRaw, statesRaw, citiesRaw] = await Promise.all([
    downloadJson("countries.json") as Promise<RawCountry[]>,
    downloadJson("states.json") as Promise<RawState[]>,
    downloadGzipJson("cities.json.gz") as Promise<RawCity[]>,
  ]);

  console.log(
    `\nDownloaded: ${countriesRaw.length} countries, ${statesRaw.length} states, ${citiesRaw.length} cities\n`
  );

  // Insert countries
  await batchInsert("countries", countriesRaw, async (batch) => {
    await prisma.country.createMany({
      data: batch.map((c) => ({
        id: c.id,
        name: c.name,
        iso3: c.iso3,
        iso2: c.iso2,
        numericCode: c.numeric_code || null,
        phonecode: c.phonecode || null,
        capital: c.capital || null,
        currency: c.currency || null,
        currencyName: c.currency_name || null,
        currencySymbol: c.currency_symbol || null,
        tld: c.tld || null,
        native: c.native || null,
        region: c.region || null,
        subregion: c.subregion || null,
        nationality: c.nationality || null,
        latitude: parseCoord(c.latitude),
        longitude: parseCoord(c.longitude),
        emoji: c.emoji || null,
        emojiU: c.emojiU || null,
      })),
      skipDuplicates: true,
    });
  });

  // Insert states
  // Build a set of valid country IDs for filtering
  const validCountryIds = new Set(countriesRaw.map((c) => c.id));
  const validStates = statesRaw.filter((s) => validCountryIds.has(s.country_id));

  await batchInsert("states", validStates, async (batch) => {
    await prisma.state.createMany({
      data: batch.map((s) => ({
        id: s.id,
        name: s.name,
        countryId: s.country_id,
        countryCode: s.country_code,
        stateCode: s.state_code || null,
        type: s.type || null,
        latitude: parseCoord(s.latitude),
        longitude: parseCoord(s.longitude),
      })),
      skipDuplicates: true,
    });
  });

  // Insert cities
  const validStateIds = new Set(validStates.map((s) => s.id));
  const validCities = citiesRaw.filter(
    (c) => validStateIds.has(c.state_id) && validCountryIds.has(c.country_id)
  );

  await batchInsert("cities", validCities, async (batch) => {
    await prisma.city.createMany({
      data: batch.map((c) => ({
        id: c.id,
        name: c.name,
        stateId: c.state_id,
        countryId: c.country_id,
        countryCode: c.country_code,
        stateCode: c.state_code || null,
        latitude: parseCoord(c.latitude),
        longitude: parseCoord(c.longitude),
      })),
      skipDuplicates: true,
    });
  });

  // Post-import: fix Romanian names
  console.log("\nApplying Romanian name fixes...");
  await prisma.state.updateMany({
    where: { id: 4730 },
    data: { name: "București" },
  });
  await prisma.city.updateMany({
    where: { id: 90347 },
    data: { name: "București" },
  });
  console.log("  Renamed Bucharest → București (state + city)");

  console.log("\nGeographic data import complete!");

  // Quick stats
  const [finalCountries, finalStates, finalCities] = await Promise.all([
    prisma.country.count(),
    prisma.state.count(),
    prisma.city.count(),
  ]);
  console.log(
    `Final counts: ${finalCountries} countries, ${finalStates} states, ${finalCities} cities`
  );
}

main()
  .catch((e) => {
    console.error("Import failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
