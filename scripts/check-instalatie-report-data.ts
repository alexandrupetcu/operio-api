/**
 * Smoke-check for `buildInstalatieReportData` — the placeholders behind the RT
 * (fișă revizie tehnică) and PV (recepție tehnică) documents. Covers the v2
 * line-item materials, the unit conversions the forms don't do (mbar → bar,
 * minutes → hours), the Tabel 4 material column, and reports written in the old
 * fixed țeavă/armături/detector shape.
 *
 * No DB or Redis needed. Run: npx tsx scripts/check-instalatie-report-data.ts
 */
import { buildInstalatieReportData } from "../src/workers/document-generation.worker.js";

const fails: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
  const ok = String(actual) === String(expected);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
  if (!ok) fails.push(name);
};

const installation = {
  distributorName: "DELGAZ GRID",
  documentatieNr: "4412/2019",
  appliancesJson: [{ kind: "CT", name: "Centrală Vaillant", debit: "2.5", count: 1 }],
};

// ── v2 report: positions carry the material, probes carry their own unit ──
const v2 = await buildInstalatieReportData(
  {
    reportKind: "revizie_instalatie",
    operatiuni: { arzatoare: "DA" },
    probaRezistenta: { amplasare: "suprateran", regim: "joasa", presiune: "6", presiuneUm: "bar", timp: "30", admis: true },
    probaEtanseitate: { amplasare: "suprateran", regim: "joasa", presiune: "100", presiuneUm: "mbar", timp: "1440", admis: true },
    pv: {
      acordAccesNr: "12/2019",
      materiale: [
        { kind: "teava", material: "PE100", cantitate: "12", furnizor: "Valrom", certificat: "4412/11.04.2019" },
        { kind: "armatura", material: "OL (oțel)", diametru: '3/4"', cantitate: "2", furnizor: "Romstal" },
        { kind: "c_teu_x1", label: "Teu de branșament", um: "buc", material: "Cupru", cantitate: "1" },
      ],
    },
    decizie: "admis",
    nextDate: "2036-07-24",
  },
  installation,
  null,
);

check("rânduri materiale", (v2.pv_materiale_table.match(/<tr>/g) ?? []).length, 3);
check("etichetă tip propriu", v2.pv_materiale_table.includes("Teu de branșament"), true);
check("cantitate cu UM", v2.pv_materiale_table.includes("12 m"), true);
check("diametru escapat", v2.pv_materiale_table.includes("3/4&quot;"), true);
check("material conductă (PV pct. 7)", v2.pv_sup_material, "PE100");
check("PV rezistență → bar", v2.pv_sup_rez_presiune, "6");
check("PV rezistență → ore", v2.pv_sup_rez_timp, "0,5");
check("PV etanșeitate 100 mbar → bar", v2.pv_sup_et_presiune, "0,1");
check("PV etanșeitate 1440 min → ore", v2.pv_sup_et_timp, "24");
check("PV rezultat", v2.pv_sup_rezultat, "ADMIS");
check("PV secțiune subterană goală", v2.pv_sub_rezultat, "---");
check("PV punct consum = denumire", v2.pv_puncte_consum_table.includes("Centrală Vaillant"), true);
check("RT grilă: PE100 joasă", v2.proba_rez_pe100_sub_joasa, '<span class="f">6</span>');
check("RT grilă: coloana OL goală", v2.proba_rez_ol_supra_joasa, "");
check("RT grilă etanșeitate în bar", v2.proba_et_pe100_sub_joasa, '<span class="f">0,1</span>');
check("RT timp probă (h)", v2.proba_rez_timp, "0,5");
check("RT clasa OL (pct. 10)", v2.pv_conducta_ol, "X");
check("RT clasa PE (pct. 11)", v2.pv_conducta_pe, "X");
check("scadență ISO → RO", v2.next_date, "24.07.2036");

// ── un test picat nu poate ieși ADMIS ──
const respins = await buildInstalatieReportData(
  {
    reportKind: "revizie_instalatie",
    probaRezistenta: { amplasare: "subteran", regim: "joasa", presiune: "6", presiuneUm: "bar", timp: "30", admis: true },
    probaEtanseitate: { amplasare: "subteran", regim: "joasa", presiune: "100", presiuneUm: "mbar", timp: "1440", admis: false },
    pv: { materiale: [{ kind: "teava", material: "Cupru", cantitate: "8" }] },
    decizie: "respins",
  },
  installation,
  null,
);
check("rezultat cu o probă picată", respins.pv_sub_rezultat, "RESPINS");
check("secțiune subterană activă", respins.pv_sup_rezultat, "---");
check("Cupru → coloana OL subteran", respins.proba_rez_ol_sub_joasa, '<span class="f">6</span>');

// ── raport vechi (forma fixă țeavă/armături/detector) ──
const legacy = await buildInstalatieReportData(
  {
    reportKind: "revizie_instalatie",
    probaRezistenta: { material: "PE80", amplasare: "subteran", regim: "medie", presiune: "4", timp: "60", admis: true },
    pv: {
      teava: { diametru: "32", cantitate: "10", furnizor: "Wavin", certificat: "77/2020" },
      armaturi: { diametru: "1", cantitate: "2" },
      conducta: "PE",
    },
    decizie: "admis",
    nextDate: "20.07.2030",
  },
  installation,
  null,
);
check("legacy: rânduri", (legacy.pv_materiale_table.match(/<tr>/g) ?? []).length, 3);
check("legacy: țeavă", legacy.pv_materiale_table.includes("10 m"), true);
check("legacy: material conductă", legacy.pv_sub_material, "PE100");
check("legacy: grilă PE100 medie", legacy.proba_rez_pe100_sub_medie, '<span class="f">4</span>');
check("legacy: presiune fără unitate → bar", legacy.pv_sub_rez_presiune, "4");
check("legacy: scadență RO păstrată", legacy.next_date, "20.07.2030");

// ── raport gol: tabelul nu trebuie să dispară ──
const empty = await buildInstalatieReportData({ reportKind: "revizie_instalatie", decizie: "admis" }, null, null);
check("gol: 3 rânduri libere", (empty.pv_materiale_table.match(/<tr>/g) ?? []).length, 3);

console.log(fails.length ? `\n${fails.length} verificări picate` : "\nToate verificările au trecut");
process.exit(fails.length ? 1 : 0);
