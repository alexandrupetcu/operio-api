// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * Configurație plată minimală (ESLint 9). Până acum nu exista niciun fișier de
 * configurare, deci `npx eslint .` cădea cu „couldn't find eslint.config.js" —
 * de aceea pasul de lint din CI e `continue-on-error: true`: raportează
 * restanța existentă, fără să blocheze.
 *
 * Nu folosim reguli „type-aware" (`recommendedTypeChecked`): verificarea de
 * tipuri o face `tsc --noEmit`, care e blocant.
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "documente/**", "templates/**", "prisma/migrations/**", "*.tsbuildinfo"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // Zgomot pe un cod existent de ~45 kloc; tsc acoperă deja ce conta.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },
  {
    // Testele: `expect`/`describe` vin din vitest (importate explicit), dar
    // aserțiunile cer des `any`/non-null.
    files: ["src/**/*.test.ts", "src/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["scripts/**/*.{ts,mjs,js}", "prisma/**/*.ts"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
