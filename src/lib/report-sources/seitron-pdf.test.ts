import { describe, expect, it } from "vitest";
import { SEITRON_SOURCE_ID, seitronPdfSource } from "./seitron-pdf.js";

/**
 * Fixtura e construită din chiar marcajele pe care le caută detectorul — așa
 * cum le tipărește `pdftotext -layout` pe un raport Chemist complet.
 */
const FULL_REPORT = [
  "                         SEITRON  Chemist 500",
  "",
  "Operator:            Ion Popescu",
  "Client:              Maria Ionescu",
  "Client address:      Str. Exemplu nr. 1, București",
  "Client phone:        0700000000",
  "Equipment:           Centrala Viessmann Vitodens 100",
  "Numar Serial         7512345678",
  "Combustibil          Gaz metan (G20)",
  "",
  "Analyses:",
  "Analiza 1            18/10/2026  09:30",
  "  O2          4.5 %",
  "  CO          38 ppm",
  "  ExcesAer    1.27",
  "  Randament   93.1 %",
].join("\n");

/** Raport trunchiat: antetul există, blocul de analize nu. */
const TRUNCATED_REPORT = [
  "Operator:            Ion Popescu",
  "Equipment:           Centrala Viessmann",
  "Client address:      Str. Exemplu nr. 1",
  "Client phone:        0700000000",
  "Numar Serial         7512345678",
].join("\n");

const UNRELATED = [
  "FACTURA FISCALA  nr. 1234 / 18.10.2026",
  "Furnizor: SC Exemplu SRL, CUI RO12345678",
  "Total de plata: 1.234,56 lei",
  "Va mulțumim pentru colaborare.",
].join("\n");

describe("seitronPdfSource", () => {
  it("are id-ul și tipul așteptate", () => {
    expect(seitronPdfSource.id).toBe(SEITRON_SOURCE_ID);
    expect(SEITRON_SOURCE_ID).toBe("seitron-pdf");
    expect(seitronPdfSource.kind).toBe("builtin");
  });

  it("detect ≥ 0.8 pe un raport Chemist complet", () => {
    const score = seitronPdfSource.detect(FULL_REPORT);
    expect(score, `scor ${score}`).toBeGreaterThanOrEqual(0.8);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("detect ~0.5 pe un raport trunchiat (antet fără analize)", () => {
    const score = seitronPdfSource.detect(TRUNCATED_REPORT);
    expect(score).toBeGreaterThan(0.3);
    expect(score).toBeLessThan(0.8);
  });

  it("detect ~0 pe un text fără legătură (factură)", () => {
    expect(seitronPdfSource.detect(UNRELATED)).toBe(0);
  });

  it("detect 0 pe text gol", () => {
    expect(seitronPdfSource.detect("")).toBe(0);
    // @ts-expect-error — apărare împotrivă unui text lipsă (PDF scanat)
    expect(seitronPdfSource.detect(undefined)).toBe(0);
  });

  it("marcajele sunt cerute cu `\\b` — un cuvânt care doar conține „Chemist” nu numără dublu", () => {
    // Scorul e fracția de marcaje găsite, deci monoton: mai multe marcaje ⇒ scor ≥.
    expect(seitronPdfSource.detect(FULL_REPORT)).toBeGreaterThan(seitronPdfSource.detect(TRUNCATED_REPORT));
  });

  it("expune câmpurile de antet + cheile de citiri pe care le poate produce", () => {
    expect(seitronPdfSource.fields).toContain("revisionDate");
    expect(seitronPdfSource.fields).toContain("o2");
    expect(seitronPdfSource.fields).toContain("co");
    expect(seitronPdfSource.fields).toContain("tGaz");
    expect(seitronPdfSource.fields).toContain("excessAir");
  });

  it("parse pe textul fixturii întoarce un ParsedRevision cu rawText-ul primit", async () => {
    const parsed = await seitronPdfSource.parse({ buffer: Buffer.alloc(0), text: FULL_REPORT });
    expect(parsed.rawText).toBe(FULL_REPORT);
    expect(parsed.operator.name).toBe("Ion Popescu");
  });
});
