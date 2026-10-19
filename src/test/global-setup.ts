import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { resolveTestDbUrl } from "./test-db-url.js";

/**
 * Pregătirea bazei de test, o singură dată pe rulare:
 *   1. verifică `TEST_DATABASE_URL` (refuză baza de dezvoltare — vezi test-db-url.ts);
 *   2. creează baza dacă lipsește (`CREATE DATABASE`, prin baza `postgres`);
 *   3. rulează `prisma migrate deploy` — care e și o verificare de drift: dacă
 *      istoricul migrărilor nu se aplică curat pe o bază goală, suita cade aici.
 *
 * Fără `TEST_DATABASE_URL` nu facem nimic: `scripts/test-int.mjs` sare suita cu
 * un mesaj clar înainte de a ajunge aici.
 */
export default async function setup() {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new Error("TEST_DATABASE_URL nu e setat — rulează `npm run test:int`.");

  const { url, database, maintenanceUrl } = resolveTestDbUrl(raw);

  // 1. Baza există?
  const admin = new PrismaClient({ datasources: { db: { url: maintenanceUrl } } });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
    console.log(`[int] baza ${database} a fost creată`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 42P04 = duplicate_database — exact ce vrem în rulările următoare.
    if (!/already exists|42P04/i.test(msg)) {
      throw new Error(`[int] nu am putut crea baza ${database}: ${msg}`);
    }
  } finally {
    await admin.$disconnect().catch(() => undefined);
  }

  // 2. Migrările (și garda de drift).
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });

  // Serviciile citesc `env.DATABASE_URL`; worker-ii vitest pornesc după setup.
  process.env.DATABASE_URL = url;
}
