#!/usr/bin/env node
/**
 * Poarta suitei de integrare: fără `TEST_DATABASE_URL` nu rulăm nimic și
 * spunem clar de ce (ieșire 0 — lipsa unui Postgres de test nu e o eroare
 * pentru dezvoltatorul care rulează doar `npm test`).
 *
 * Restul (crearea bazei, `prisma migrate deploy`) se face în
 * `src/test/global-setup.ts`, ca să se întâmple și când se rulează direct
 * `npx vitest --project int`.
 */
import { spawn } from "node:child_process";

function suggestUrl() {
  const dev = process.env.DATABASE_URL;
  if (!dev) return "postgresql://operio:<parola din .env>@localhost:5433/operio_test";
  try {
    const u = new URL(dev);
    u.pathname = "/operio_test";
    return u.toString();
  } catch {
    return "postgresql://operio:<parola din .env>@localhost:5433/operio_test";
  }
}

if (!process.env.TEST_DATABASE_URL) {
  console.log(
    [
      "",
      "  ⏭  Testele de integrare au fost SĂRITE: TEST_DATABASE_URL nu e setat.",
      "",
      "     Au nevoie de un Postgres separat de baza de dezvoltare. Cu docker-compose",
      "     pornit (`docker compose up -d postgres`), rulează:",
      "",
      `       TEST_DATABASE_URL=${suggestUrl()} npm run test:int`,
      "",
      "     Baza se creează automat dacă lipsește, iar migrările se aplică cu",
      "     `prisma migrate deploy`. Numele bazei trebuie să se termine cu „_test”.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const args = ["vitest", "run", "--project", "int", ...process.argv.slice(2)];
const child = spawn("npx", args, { stdio: "inherit", env: process.env });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
