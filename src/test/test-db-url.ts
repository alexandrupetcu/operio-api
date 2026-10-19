/**
 * Rezolvarea și verificarea URL-ului bazei de test.
 *
 * Singura regulă care contează: suita de integrare NU are voie să atingă baza
 * de dezvoltare. De aceea numele bazei e verificat explicit și un `operio`
 * (sau `operio_prod`, sau orice nu se termină cu `_test`) oprește rularea.
 */

/** Bazele pe care refuzăm din principiu, oricât de explicit ar fi cerute. */
const FORBIDDEN_DATABASES = new Set(["operio", "operio_prod", "operio_production", "postgres"]);

export class TestDatabaseError extends Error {}

export interface TestDbUrl {
  url: string;
  database: string;
  /** Același server, dar baza `postgres` — pentru `CREATE DATABASE`. */
  maintenanceUrl: string;
}

/** Numele bazei dintr-un URL Postgres (fără `/`, fără query string). */
export function databaseNameOf(url: string): string {
  const u = new URL(url);
  return decodeURIComponent(u.pathname.replace(/^\//, ""));
}

/**
 * Sugestia de URL pentru mesajul de skip: `DATABASE_URL` cu numele bazei
 * înlocuit cu `operio_test`, ca dezvoltatorul să nu ghicească parola locală.
 */
export function suggestTestDatabaseUrl(databaseUrl: string | undefined): string {
  const fallback = "postgresql://operio:<parola din .env>@localhost:5433/operio_test";
  if (!databaseUrl) return fallback;
  try {
    const u = new URL(databaseUrl);
    u.pathname = "/operio_test";
    return u.toString();
  } catch {
    return fallback;
  }
}

/**
 * Validează `TEST_DATABASE_URL`. Aruncă `TestDatabaseError` dacă e un URL
 * invalid sau dacă numele bazei e unul interzis (vezi `FORBIDDEN_DATABASES`)
 * ori nu se termină cu `_test`.
 */
export function resolveTestDbUrl(raw: string): TestDbUrl {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new TestDatabaseError(`TEST_DATABASE_URL nu e un URL valid: ${raw}`);
  }
  if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") {
    throw new TestDatabaseError(`TEST_DATABASE_URL trebuie să fie postgresql://…, nu ${u.protocol}`);
  }
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!database) {
    throw new TestDatabaseError("TEST_DATABASE_URL nu conține numele bazei de date");
  }
  if (FORBIDDEN_DATABASES.has(database)) {
    throw new TestDatabaseError(
      `REFUZ: TEST_DATABASE_URL arată spre baza „${database}". Testele de integrare golesc tabele — ` +
        "folosește o bază separată (ex. operio_test).",
    );
  }
  if (!database.endsWith("_test")) {
    throw new TestDatabaseError(
      `REFUZ: numele bazei de test („${database}") trebuie să se termine cu „_test", ca o greșeală de ` +
        "copiere să nu golească o bază reală.",
    );
  }
  const maintenance = new URL(raw);
  maintenance.pathname = "/postgres";
  maintenance.search = "";
  return { url: raw, database, maintenanceUrl: maintenance.toString() };
}
