import { describe, expect, it } from "vitest";
import {
  MAX_XML_CHARS,
  MAX_XML_ELEMENTS,
  RAW_PAIRS_CAP,
  detectSeparator,
  extractPairs,
  flattenCsv,
  fromPairs,
  parseXml,
  parseXmlWithReason,
  structuredFileSource,
} from "./structured-file.js";

const parse = (text: string, mapping?: Record<string, string>) =>
  structuredFileSource.parse({ buffer: Buffer.alloc(0), text, mapping });

const readings = (data: Record<string, unknown>) => (data.readings ?? {}) as Record<string, string>;
/** Data locală, independent de fusul mașinii de test. */
const ymd = (d: Date | null) =>
  d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : null;

/** Durata unui apel, în ms (performance.now() — ReDoS-ul se vede ca timp, nu ca eroare). */
function timed<T>(fn: () => T): { ms: number; value: T } {
  const t0 = performance.now();
  const value = fn();
  return { ms: performance.now() - t0, value };
}

// ───────────────────────────────────────────────────────────────────────────
// Regresie ReDoS: scanarea atributelor era O(n²) pe un singur tag lung
// ───────────────────────────────────────────────────────────────────────────

describe("regresie ReDoS — un singur tag uriaș", () => {
  it("tag de 200 KB: detect + parse sub 100 ms", async () => {
    const hostile = `<a ${"b".repeat(200 * 1024)}=x>`;
    expect(hostile.length).toBeGreaterThan(200 * 1024);

    const d = timed(() => structuredFileSource.detect(hostile));
    expect(d.value).toBe(0);
    expect(d.ms, `detect a durat ${d.ms.toFixed(1)} ms`).toBeLessThan(100);

    const t0 = performance.now();
    const parsed = await parse(hostile);
    const ms = performance.now() - t0;
    expect(parsed.analysisData._warning).toBe("not_structured");
    expect(ms, `parse a durat ${ms.toFixed(1)} ms`).toBeLessThan(100);
  });

  it("tag de 60 KB (sub plafonul de 64 KB, deci chiar se scanează): sub 100 ms", async () => {
    const hostile = `<a ${"b".repeat(60 * 1024)}=x></a>`;

    const d = timed(() => structuredFileSource.detect(hostile));
    expect(d.ms, `detect a durat ${d.ms.toFixed(1)} ms`).toBeLessThan(100);

    const t0 = performance.now();
    await parse(hostile);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it("multe atribute scurte pe un tag rămân liniare", () => {
    // Rămânem sub plafonul de 64 KB pe tag, ca tagul să fie chiar scanat.
    const attrs = Array.from({ length: 3_000 }, (_, i) => `a${i}="v${i}"`).join(" ");
    const d = timed(() => parseXml(`<r ${attrs}><x>1</x></r>`));
    expect(d.ms, `${d.ms.toFixed(1)} ms`).toBeLessThan(100);
    expect(d.value).not.toBeNull();
  });

  it("ghilimea neînchisă într-un atribut → malformed, fără buclă", () => {
    const { root, reason } = parseXmlWithReason(`<r a="never closed><x>1</x></r>`);
    expect(root).toBeNull();
    expect(reason).toBe("malformed");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Entități numerice în afara Unicode / surogate
// ───────────────────────────────────────────────────────────────────────────

describe("decodarea entităților nu aruncă RangeError", () => {
  const xml =
    "<r><a>&#x110000;</a><b>&#99999999999;</b><c>&#xD800;</c><d>1</d><e>2</e><f>3</f></r>";

  it("&#x110000; / &#99999999999; / &#xD800; se păstrează literal", async () => {
    const parsed = await parse(xml);
    const raw = parsed.analysisData.rawPairs as { label: string; value: string }[];
    const byLabel = Object.fromEntries(raw.map((p) => [p.label, p.value]));
    expect(byLabel["r/a"]).toBe("&#x110000;");
    expect(byLabel["r/b"]).toBe("&#99999999999;");
    expect(byLabel["r/c"]).toBe("&#xD800;");
  });

  it("extractPairs nu aruncă pe entități imposibile", () => {
    expect(() => extractPairs(xml)).not.toThrow();
    expect(extractPairs(xml).kind).toBe("xml");
  });

  it("entitățile valide se decodează (text și atribute)", async () => {
    const parsed = await parse('<r><a>&lt;b&gt; &amp; &#65; &#x42;</a><n>1</n><m>2</m><o>3</o></r>');
    const raw = parsed.analysisData.rawPairs as { label: string; value: string }[];
    expect(raw.find((p) => p.label === "r/a")?.value).toBe("<b> & A B");
  });

  it("entitate necunoscută → literal", () => {
    const { pairs } = extractPairs("<r><a>&nbsp;x</a><n>1</n><m>2</m><o>3</o></r>");
    expect(pairs.find((p) => p.label === "a")?.value).toBe("&nbsp;x");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Limite de protecție
// ───────────────────────────────────────────────────────────────────────────

describe("limite de protecție", () => {
  it("20 000 de niveluri de imbricare → malformed, fără stack overflow", async () => {
    const deep = `${"<a>".repeat(20_000)}1${"</a>".repeat(20_000)}`;
    const { root, reason } = parseXmlWithReason(deep);
    expect(root).toBeNull();
    expect(reason).toBe("malformed");

    expect(structuredFileSource.detect(deep)).toBe(0);
    const parsed = await parse(deep);
    expect(parsed.analysisData._warning).toBe("not_structured");
    expect(Object.keys(readings(parsed.analysisData))).toEqual([]);
  });

  it("peste 2 MB → too_large, detect 0, _warning xml_too_large", async () => {
    const big = `<r>${"<x>1</x>".repeat(Math.ceil(MAX_XML_CHARS / 8) + 10)}</r>`;
    expect(big.length).toBeGreaterThan(MAX_XML_CHARS);
    expect(parseXmlWithReason(big).reason).toBe("too_large");
    expect(structuredFileSource.detect(big)).toBe(0);
    expect((await parse(big)).analysisData._warning).toBe("xml_too_large");
  });

  it("peste 50 000 de elemente (dar sub 2 MB) → too_many_elements", async () => {
    const many = `<r>${"<x/>".repeat(MAX_XML_ELEMENTS + 100)}</r>`;
    expect(many.length).toBeLessThan(MAX_XML_CHARS);
    expect(parseXmlWithReason(many).reason).toBe("too_many_elements");
    expect(structuredFileSource.detect(many)).toBe(0);
    expect((await parse(many)).analysisData._warning).toBe("xml_too_many_elements");
  });

  it("rawPairs e plafonat la 200, cu numărul celor tăiate", async () => {
    const n = RAW_PAIRS_CAP + 37;
    const xml = `<r>${Array.from({ length: n }, (_, i) => `<v${i}>${i + 1}</v${i}>`).join("")}</r>`;
    const parsed = await parse(xml);
    expect((parsed.analysisData.rawPairs as unknown[]).length).toBe(RAW_PAIRS_CAP);
    expect(parsed.analysisData.rawPairsTruncated).toBe(37);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// XML tip ZIV (testo / Wöhler / MRU)
// ───────────────────────────────────────────────────────────────────────────

describe("XML tip ZIV", () => {
  const ziv =
    "<Messung>" +
    "<Datum>18.10.2026</Datum>" +
    '<O2 unit="%">4.5</O2>' +
    '<CO unit="ppm">38</CO>' +
    '<AbgasTemp unit="°C">61.2</AbgasTemp>' +
    '<Zug unit="Pa">-12</Zug>' +
    "<Wirkungsgrad>93.1</Wirkungsgrad>" +
    "</Messung>";

  it("e recunoscut ca XML cu încredere mare", () => {
    expect(structuredFileSource.detect(ziv)).toBe(0.9);
    expect(extractPairs(ziv).kind).toBe("xml");
  });

  it("rezolvă o2 / co / tGaz / draft / et, cu unitatea lipită", async () => {
    const r = readings((await parse(ziv)).analysisData);
    expect(r.o2).toBe("4.5 %");
    expect(r.co).toBe("38 ppm");
    expect(r.tGaz).toBe("61.2 °C");
    expect(r.draft).toBe("-12 Pa");
    expect(r.et).toBe("93.1");
  });

  it("rezolvă data (dd.mm.yyyy, în ora locală)", async () => {
    expect(ymd((await parse(ziv)).revisionDate)).toBe("2026-10-18");
  });

  it("atributul de unitate nu devine o citire proprie", async () => {
    const r = readings((await parse(ziv)).analysisData);
    expect(r.o2_unit).toBeUndefined();
    expect(Object.keys(r).sort()).toEqual(["co", "draft", "et", "o2", "tGaz"].sort());
  });

  it("prefixele de namespace se ignoră, prologul și comentariile la fel", async () => {
    const ns =
      '<?xml version="1.0" encoding="UTF-8"?><!-- export --><ziv:Messung xmlns:ziv="urn:ziv">' +
      '<ziv:O2 ziv:unit="%">4.5</ziv:O2><ziv:CO>38</ziv:CO><ziv:Wirkungsgrad>93.1</ziv:Wirkungsgrad>' +
      "</ziv:Messung>";
    const r = readings((await parse(ns)).analysisData);
    expect(r.o2).toBe("4.5 %");
    expect(r.co).toBe("38");
    expect(r.et).toBe("93.1");
  });

  it("aliasurile pe ultimele două segmente ale căii („Kunde/Name”)", async () => {
    const xml =
      "<Protokoll><Kunde><Name>Popescu</Name><Vorname>Ion</Vorname></Kunde>" +
      "<Messung><O2>4.5</O2><CO>38</CO><Wirkungsgrad>93.1</Wirkungsgrad></Messung></Protokoll>";
    const parsed = await parse(xml);
    expect(parsed.clientName).toBe("Popescu");
    expect(parsed.clientSurname).toBe("Ion");
  });

  it("virgula zecimală din XML devine punct", async () => {
    const r = readings((await parse("<r><O2>4,5</O2><CO>38</CO><Wirkungsgrad>93,1</Wirkungsgrad></r>")).analysisData);
    expect(r.o2).toBe("4.5");
    expect(r.et).toBe("93.1");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CSV
// ───────────────────────────────────────────────────────────────────────────

describe("CSV tip Seitron (`;` + virgulă zecimală)", () => {
  const csv =
    "Data;Ora;O2;CO;Temperatura fumi;Randament;Tiraj\n" + "18.10.2026;09:30;4,5;38;61,2;93,1;-12\n";

  it("separatorul `;` câștigă peste virgula zecimală", () => {
    expect(detectSeparator(csv.trim().split("\n"))).toBe(";");
  });

  it("detect ≥ 0.7", () => {
    expect(structuredFileSource.detect(csv)).toBeGreaterThanOrEqual(0.7);
    expect(extractPairs(csv).kind).toBe("csv");
  });

  it("antet + rând de date → citiri rezolvate, cu virgula convertită", async () => {
    const parsed = await parse(csv);
    expect(readings(parsed.analysisData)).toEqual({
      o2: "4.5",
      co: "38",
      tGaz: "61.2",
      et: "93.1",
      draft: "-12",
    });
    expect(ymd(parsed.revisionDate)).toBe("2026-10-18");
    expect(parsed.analysisData.ora).toBe("09:30");
    expect(parsed.analysisData.fileKind).toBe("csv");
  });

  it("al doilea rând de date nu suprascrie primul", async () => {
    const two = csv + "19.10.2026;10:30;9,9;99;99,9;11,1;-99\n";
    const r = readings((await parse(two)).analysisData);
    expect(r.o2).toBe("4.5");
    expect(r.co).toBe("38");
  });

  it("rândul de unități de sub antet se lipește de valoare", async () => {
    const withUnits = "Data;O2;CO;Randament\n;%;ppm;%\n18.10.2026;4,5;38;93,1\n";
    const r = readings((await parse(withUnits)).analysisData);
    expect(r.o2).toBe("4.5 %");
    expect(r.co).toBe("38 ppm");
    expect(r.et).toBe("93.1 %");
  });

  it("separator tab e recunoscut", () => {
    const tabbed = "Data\tO2\tCO\tRandament\n18.10.2026\t4.5\t38\t93.1\n";
    expect(detectSeparator(tabbed.trim().split("\n"))).toBe("\t");
    expect(structuredFileSource.detect(tabbed)).toBeGreaterThanOrEqual(0.7);
  });

  it("câmpurile între ghilimele cu separator înăuntru rămân întregi", () => {
    const pairs = flattenCsv('Nume;O2;CO;Randament\n"Popescu; Ion";4,5;38;93,1\n');
    expect(pairs.find((p) => p.label === "Nume")?.value).toBe("Popescu; Ion");
  });
});

describe("CSV pe două coloane (etichetă;valoare)", () => {
  const kv = "Data;18.10.2026\nO2;4,5\nCO;38\nTemperatura fumi;61,2\nRandament;93,1\n";

  it("detect ≥ 0.7 și rezolvare completă", async () => {
    expect(structuredFileSource.detect(kv)).toBeGreaterThanOrEqual(0.7);
    const parsed = await parse(kv);
    expect(readings(parsed.analysisData)).toEqual({ o2: "4.5", co: "38", tGaz: "61.2", et: "93.1" });
    expect(ymd(parsed.revisionDate)).toBe("2026-10-18");
  });

  it("forma pe trei coloane (etichetă;valoare;unitate)", async () => {
    const kvu = "Data;18.10.2026\nO2;4,5;%\nCO;38;ppm\nTemperatura fumi;61,2;°C\nRandament;93,1;%\n";
    expect(structuredFileSource.detect(kvu)).toBeGreaterThanOrEqual(0.7);
    const r = readings((await parse(kvu)).analysisData);
    expect(r).toEqual({ o2: "4.5 %", co: "38 ppm", tGaz: "61.2 °C", et: "93.1 %" });
  });

  it("text fără nicio pereche numerică → detect 0", () => {
    expect(structuredFileSource.detect("Raport de service\nNu sunt valori aici\nMulțumim")).toBe(0);
    expect(structuredFileSource.detect("")).toBe(0);
    expect(structuredFileSource.detect("   ")).toBe(0);
  });

  it("valorile goale sau „---” / „N/A” se ignoră", async () => {
    const r = readings((await parse("Data;18.10.2026\nO2;---\nCO;38\nRandament;93,1\nTiraj;n/a\n")).analysisData);
    expect(r.o2).toBeUndefined();
    expect(r.draft).toBeUndefined();
    expect(r.co).toBe("38");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Prototype pollution
// ───────────────────────────────────────────────────────────────────────────

describe("chei periculoase din fișier", () => {
  const before = JSON.stringify(Object.getOwnPropertyNames(Object.prototype));

  it("`__proto__` / `constructor` / `prototype` ca etichetă CSV nu ajung în readings", async () => {
    const csv = "__proto__;1\nconstructor;2\nprototype;3\nO2;4,5\nCO;38\n";
    const parsed = await parse(csv);
    const r = readings(parsed.analysisData);
    expect(Object.hasOwn(r, "__proto__")).toBe(false);
    expect(Object.hasOwn(r, "constructor")).toBe(false);
    expect(Object.hasOwn(r, "prototype")).toBe(false);
    expect(r.o2).toBe("4.5");
    // `readings` e creat cu Object.create(null): nici prototip de poluat.
    expect(Object.getPrototypeOf(r)).toBeNull();
  });

  it("`__proto__` ca nume de tag XML nu ajunge în readings", async () => {
    const xml = "<r><__proto__>1</__proto__><constructor>2</constructor><O2>4.5</O2><CO>38</CO></r>";
    const r = readings((await parse(xml)).analysisData);
    expect(Object.hasOwn(r, "__proto__")).toBe(false);
    expect(Object.hasOwn(r, "constructor")).toBe(false);
    expect(r.o2).toBe("4.5");
  });

  it("`__proto__` ca nume de atribut XML e ignorat", () => {
    const { pairs } = extractPairs('<r __proto__="x" constructor="y" unit="%"><O2>4.5</O2><CO>38</CO><Randament>93.1</Randament></r>');
    expect(pairs.some((p) => p.label.includes("__proto__"))).toBe(false);
    expect(pairs.some((p) => p.label.includes("constructor"))).toBe(false);
  });

  it("mapping-ul firmei nu poate direcționa o valoare spre `__proto__`", () => {
    const parsed = fromPairs(
      [
        { label: "Foo", path: "Foo", value: "7" },
        { label: "Bar", path: "Bar", value: "8" },
        { label: "O2", path: "O2", value: "4.5" },
      ],
      "",
      { Foo: "__proto__", Bar: "constructor" },
    );
    const r = readings(parsed.analysisData);
    expect(Object.hasOwn(r, "__proto__")).toBe(false);
    expect(Object.hasOwn(r, "constructor")).toBe(false);
    expect(r.o2).toBe("4.5");
  });

  it("o etichetă `constructor` din mapping nu nimerește prototipul mapping-ului", () => {
    // mappedKey folosește Object.hasOwn: un mapping fără cheia „constructor" nu
    // trebuie să întoarcă funcția Object.prototype.constructor.
    const parsed = fromPairs(
      [
        { label: "constructor", path: "constructor", value: "1" },
        { label: "O2", path: "O2", value: "4.5" },
      ],
      "",
      { O2: "o2" },
    );
    const r = readings(parsed.analysisData);
    expect(typeof r.o2).toBe("string");
    for (const v of Object.values(r)) expect(typeof v).toBe("string");
  });

  it("Object.prototype a rămas neatins după toate testele de mai sus", () => {
    expect(JSON.stringify(Object.getOwnPropertyNames(Object.prototype))).toBe(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Parserul XML — bine/rău format
// ───────────────────────────────────────────────────────────────────────────

describe("parseXmlWithReason", () => {
  it("taguri încrucișate → malformed", () => {
    expect(parseXmlWithReason("<a><b></a></b>").reason).toBe("malformed");
  });

  it("tag neînchis → malformed", () => {
    expect(parseXmlWithReason("<a><b>1</b>").reason).toBe("malformed");
  });

  it("text fără niciun element → malformed", () => {
    expect(parseXmlWithReason("doar text").reason).toBe("malformed");
  });

  it("CDATA, self-closing, DOCTYPE cu subset intern", () => {
    const xml = '<!DOCTYPE r [<!ENTITY x "y">]><r><a><![CDATA[1 > 0]]></a><b/><c>2</c></r>';
    const root = parseXml(xml);
    expect(root).not.toBeNull();
    expect(root!.name).toBe("r");
  });

  it("BOM-ul de la început nu încurcă detecția", () => {
    expect(parseXml("﻿<r><a>1</a></r>")).not.toBeNull();
  });
});
