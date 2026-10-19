import { describe, expect, it } from "vitest";
import {
  DEFAULT_LABEL_ALIASES,
  HEADER_ALIAS_KEYS,
  aliasKey,
  isHeaderAliasKey,
  mappedKey,
  normalizeLabel,
  resolveReadingKey,
  slugKey,
} from "./aliases.js";

describe("normalizeLabel", () => {
  it("trim + lowercase + spații colapsate", () => {
    expect(normalizeLabel("  T   GAZ ")).toBe("t gaz");
  });

  it("„CO(0.0%)” / „CO (0 %)” / „CO(0,0%)” → „co(0%)”", () => {
    expect(normalizeLabel("CO(0.0%)")).toBe("co(0%)");
    expect(normalizeLabel("CO (0 %)")).toBe("co(0%)");
    expect(normalizeLabel("CO(0,00%)")).toBe("co(0%)");
    expect(normalizeLabel("CO(0%)")).toBe("co(0%)");
  });
});

describe("slugKey", () => {
  it("normalizează la a-z0-9 cu underscore", () => {
    expect(slugKey("Presiune rampă")).toBe("presiune_ramp");
    expect(slugKey("Temp. fumi")).toBe("temp_fumi");
    expect(slugKey("NO2 [mg/m3]")).toBe("no2_mg_m3");
  });

  it("taie underscore-urile de la capete", () => {
    expect(slugKey("__proto__")).toBe("proto");
    expect(slugKey("  -- x -- ")).toBe("x");
  });

  it("etichetă fără niciun caracter util → „value”", () => {
    expect(slugKey("---")).toBe("value");
    expect(slugKey("")).toBe("value");
  });
});

describe("aliasKey — română / engleză / germană / italiană", () => {
  const cases: [string, string][] = [
    // română
    ["Temperatura gaze arse", "tGaz"],
    ["T aer", "tAer"],
    ["Oxigen", "o2"],
    ["Monoxid de carbon", "co"],
    ["CO corectat", "coCorr"],
    ["Exces aer", "excessAir"],
    ["Randament", "et"],
    ["Tiraj", "draft"],
    ["Pierderi", "qs"],
    ["Presiune rampă", "gasPressureRamp"],
    ["Presiune arzător", "gasPressureBurner"],
    // germană (ZIV)
    ["Abgastemperatur", "tGaz"],
    ["AbgasTemp", "tGaz"],
    ["Umgebungstemperatur", "tAer"],
    ["Sauerstoff", "o2"],
    ["Kohlenmonoxid", "co"],
    ["CO unverdünnt", "coCorr"],
    ["Luftzahl", "lambda"],
    ["Luftüberschuss", "excessAir"],
    ["Wirkungsgrad", "et"],
    ["Abgasverlust", "qs"],
    ["Zug", "draft"],
    ["Förderdruck", "draft"],
    ["Kaminzug", "draft"],
    // italiană (Seitron)
    ["Temperatura fumi", "tGaz"],
    ["T.aria", "tAer"],
    ["Ossigeno", "o2"],
    ["Monossido di carbonio", "co"],
    ["Eccesso d'aria", "excessAir"],
    ["Rendimento di combustione", "et"],
    ["Tiraggio", "draft"],
    ["Perdite al camino", "qs"],
    // engleză
    ["Flue gas temperature", "tGaz"],
    ["Ambient temperature", "tAer"],
    ["Carbon dioxide", "co2"],
    ["Excess air", "excessAir"],
    ["Combustion efficiency", "et"],
    ["Poison index", "pi"],
    ["Flue draught", "draft"],
  ];

  for (const [label, key] of cases) {
    it(`„${label}” → ${key}`, () => {
      expect(aliasKey(label)).toBe(key);
    });
  }

  it("e insensibil la majuscule și spații în plus", () => {
    expect(aliasKey("  WIRKUNGSGRAD  ")).toBe("et");
    expect(aliasKey("temperatura   fumi")).toBe("tGaz");
  });

  it("CO corectat la 0% O2 în toate scrierile", () => {
    for (const l of ["CO(0%)", "CO (0 %)", "CO(0.0%)", "CO corr", "CO undiluted", "CO korrigiert"]) {
      expect(aliasKey(l), l).toBe("coCorr");
    }
  });

  it("etichetă necunoscută → undefined", () => {
    expect(aliasKey("Ceva ce nu există")).toBeUndefined();
  });

  it("nu returnează chei moștenite din Object.prototype", () => {
    expect(aliasKey("__proto__")).toBeUndefined();
    expect(aliasKey("constructor")).toBeUndefined();
    expect(aliasKey("toString")).toBeUndefined();
    expect(aliasKey("hasOwnProperty")).toBeUndefined();
    expect(aliasKey("valueOf")).toBeUndefined();
  });

  it("câmpurile de antet sunt recunoscute ca antet, nu ca citiri", () => {
    for (const k of HEADER_ALIAS_KEYS) expect(isHeaderAliasKey(k)).toBe(true);
    expect(isHeaderAliasKey("o2")).toBe(false);
    expect(isHeaderAliasKey("tGaz")).toBe(false);
    expect(aliasKey("Datum")).toBe("revisionDate");
    expect(aliasKey("Kunde")).toBe("clientName");
    expect(aliasKey("Seriennummer")).toBe("analyzerSerial");
  });

  it("tabelul nu are valori goale", () => {
    for (const [k, v] of Object.entries(DEFAULT_LABEL_ALIASES)) {
      expect(v, `alias gol pentru „${k}”`).toBeTruthy();
    }
  });

  it("fiecare cheie din tabel e deja în formă normalizată (altfel nu se potrivește niciodată)", () => {
    // `aliasKey` caută cu `normalizeLabel(label)`, deci o cheie scrisă altfel e
    // moartă. „co (0%)” e singura, și e dublura inofensivă a lui „co(0%)”.
    const knownDead = new Set(["co (0%)"]);
    const dead = Object.keys(DEFAULT_LABEL_ALIASES).filter((k) => normalizeLabel(k) !== k && !knownDead.has(k));
    expect(dead).toEqual([]);
    // Dublura moartă nu schimbă rezultatul: eticheta ajunge oricum la coCorr.
    expect(aliasKey("CO (0%)")).toBe("coCorr");
  });
});

describe("mappedKey — mapping-ul firmei", () => {
  it("potrivire exactă", () => {
    expect(mappedKey("Temp. fumi", { "Temp. fumi": "tGaz" })).toBe("tGaz");
  });

  it("potrivire după normalizare (majuscule / spații)", () => {
    expect(mappedKey("  TEMP.   FUMI ", { "Temp. fumi": "tGaz" })).toBe("tGaz");
  });

  it("fără mapping sau fără cheie → undefined", () => {
    expect(mappedKey("O2")).toBeUndefined();
    expect(mappedKey("O2", {})).toBeUndefined();
  });

  it("Object.hasOwn: `__proto__` / `constructor` din fișier nu nimeresc prototipul", () => {
    expect(mappedKey("__proto__", { O2: "o2" })).toBeUndefined();
    expect(mappedKey("constructor", { O2: "o2" })).toBeUndefined();
    expect(mappedKey("toString", { O2: "o2" })).toBeUndefined();
  });

  it("un mapping venit din JSON cu `__proto__` propriu nu poluează prototipul", () => {
    // JSON.parse creează „__proto__” ca proprietate PROPRIE, deci Object.hasOwn
    // o vede. Important e că obiectul rămâne un obiect obișnuit (prototipul lui
    // nu s-a schimbat) și că restul mapping-ului funcționează.
    const fromJson = JSON.parse('{"__proto__": {"polluted": 1}, "O2": "o2"}') as Record<string, string>;
    expect(Object.getPrototypeOf(fromJson)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(mappedKey("O2", fromJson)).toBe("o2");
  });
});

describe("resolveReadingKey — precedența mapping > alias > slug", () => {
  it("mapping-ul firmei câștigă peste alias", () => {
    expect(resolveReadingKey("O2", { O2: "co2" })).toBe("co2");
    expect(resolveReadingKey("Wirkungsgrad", { Wirkungsgrad: "es" })).toBe("es");
  });

  it("aliasul câștigă peste slug", () => {
    expect(resolveReadingKey("Wirkungsgrad")).toBe("et");
    expect(resolveReadingKey("Wirkungsgrad", { Altceva: "x" })).toBe("et");
  });

  it("fără mapping și fără alias → slug din etichetă", () => {
    expect(resolveReadingKey("Presiune la ieșire")).toBe("presiune_la_ie_ire");
    expect(resolveReadingKey("NO2")).toBe("no2");
  });

  it("mapping-ul se aplică și pe o etichetă necunoscută", () => {
    expect(resolveReadingKey("Presiune la ieșire", { "Presiune la ieșire": "gasPressureRamp" })).toBe("gasPressureRamp");
  });

  it("nu întoarce niciodată undefined", () => {
    for (const l of ["", "---", "__proto__", "Ceva"]) expect(typeof resolveReadingKey(l)).toBe("string");
  });
});
