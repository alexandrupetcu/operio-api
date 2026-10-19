import { defineConfig } from "vitest/config";

/**
 * Două proiecte, ca să nu amestecăm logica pură cu baza de date:
 *
 *   - `unit` — doar funcții pure (fără DB / rețea / S3 / Redis). Rulează oriunde,
 *     în câteva secunde, și e gata de pus ca blocant în CI.
 *   - `int`   — pe un Postgres real, pornit doar când `TEST_DATABASE_URL` e setat
 *     (vezi `src/test/global-setup.ts`, care rulează `prisma migrate deploy` o
 *     singură dată pe rulare și refuză să atingă baza de dezvoltare `operio`).
 *
 * Testele stau lângă cod: `*.test.ts` pentru unit, `*.int.test.ts` pentru
 * integrare. Nimic din suită nu importă `src/app.ts` (acela chiar pornește
 * serverul la import).
 */
export default defineConfig({
  test: {
    // Un singur Postgres, tabele comune: fișierele de integrare trebuie să ruleze
    // secvențial, ca truncate-ul unuia să nu golească datele altuia. `fileParallelism`
    // e o opțiune globală (nu per-proiect), iar suita unitară e oricum sub o secundă.
    fileParallelism: false,
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.int.test.ts", "**/node_modules/**", "**/dist/**"],
          testTimeout: 10_000,
        },
      },
      {
        test: {
          name: "int",
          environment: "node",
          include: ["src/**/*.int.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          globalSetup: ["src/test/global-setup.ts"],
          setupFiles: ["src/test/setup-int.ts"],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/lib/**", "src/modules/**"],
      exclude: ["src/**/*.test.ts", "src/test/**"],
    },
  },
});
