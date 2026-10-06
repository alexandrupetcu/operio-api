/**
 * Build the "Dosar ISCIR Template" DOCX templates from the filled examples in
 * `documente/Dosar ISCIR/`.
 *
 *   1. Convert each .doc → .docx with LibreOffice (preserves formatting) into
 *      `documente/Dosar ISCIR Template/`.
 *   2. Insert `{placeholder}` tokens (docxtemplater single-brace syntax) in place
 *      of the example values, editing only the text inside <w:t> nodes.
 *      Replacements run first per text-node (preserves all formatting); when a
 *      target value is split across runs, that paragraph is collapsed into its
 *      first run so the value can still be replaced.
 *
 * Re-runnable: always reconverts from source, then templatizes. Logs each
 * file's replacement count and SCANS the output for any leftover example value.
 *
 * Run: npx tsx scripts/build-iscir-templates.ts   (requires LibreOffice `soffice`)
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join, extname } from "node:path";
import PizZip from "pizzip";

const ROOT = join(process.cwd(), "..", "documente");
const SRC_DIR = join(ROOT, "Dosar ISCIR");
const OUT_DIR = join(ROOT, "Dosar ISCIR Template");

const SOFFICE_CANDIDATES = [
  "/opt/homebrew/bin/soffice",
  "/usr/local/bin/soffice",
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  "soffice",
];
function findSoffice(): string {
  for (const c of SOFFICE_CANDIDATES) {
    try { execFileSync(c, ["--version"], { stdio: "ignore" }); return c; } catch { /* next */ }
  }
  throw new Error("LibreOffice (soffice) not found.");
}

type Rule = { re: RegExp; to: string };

/** Flexible, case-insensitive regex from a literal: collapse whitespace, escape. */
function flex(literal: string): RegExp {
  return new RegExp(literal.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "gi");
}

// Use the existing project address field (project.address) + city/county —
// no separate street_type/street/number breakdown.
const ADDRESS_TO = "{project_address}, Loc. {project_city}, judetul {project_county}";

// ── Common rules (apply to every document) ────────────────────────────────
const COMMON: Rule[] = [
  { re: flex("S.C. PIC TERMO INSTAL GAZ S.R.L."), to: "{tenant_name}" },
  { re: flex("SC PIC TERMO INSTAL GAZ SRL"), to: "{tenant_name}" },
  { re: flex("PIC TERMO INSTAL GAZ S.R.L."), to: "{tenant_name}" },
  { re: flex("PIC TERMO INSTAL GAZ SRL"), to: "{tenant_name}" },
  { re: flex("PIC TERMO INSTAL GAZ"), to: "{tenant_name}" },
  { re: /C23[34]\/PIC\/2025/gi, to: "{proiect_nr_documentatie}" },
  { re: /COMAN\s+GABRIEL|GABRIEL\s+COMAN/gi, to: "{rte_nume}" },
  { re: /TOMA\s+DRAGOS\s+MIHAIL/gi, to: "{diriginte_nume}" },
  { re: /MIHAESCU\s+FLORIN/gi, to: "{sudor_pe_nume}" },
  { re: /STR\.?\s*SEISMOLOGILOR\s*,?\s*NR\.?\s*35\s*,?\s*LOC\.?\s*MAGURELE\s*,?\s*JUDETUL\s*ILFOV\.?/gi, to: ADDRESS_TO },
  // Obiectiv: only the standalone "Obiectiv:" value run — anchored so it does NOT
  // match the same words inside the denumire lucrării (e.g. doc 02 "EXTINDERE
  // CONDUCTA DE DISTRIBUTIE...").
  { re: /^\s*CONDUCTA DE DISTRIBUTIE SI BRANSAMENT GAZE NATURALE\.?\s*$/i, to: "{obiectiv}" },
];
// "IVAN FLORIN MADALIN" / "IVAN CALIOPA GICA" are role-dependent → per-file only.

const SEF = (): Rule => ({ re: flex("IVAN FLORIN MADALIN"), to: "{sef_santier_nume}" });
const PROIECTANT = (): Rule => ({ re: flex("IVAN CALIOPA GICA"), to: "{proiectant_nume}" });
const ADMIN = (): Rule => ({ re: /IVAN\s+CALI[O]?PA\s+GICA/gi, to: "{tenant_admin_name}" }); // matches "CALIOPA" and the "CALIPA" typo
const PV_DATE = (): Rule => ({ re: /21\.10\.2025/g, to: "{pv_data}" });
const MANOMETRU: Rule[] = [
  { re: /0-31\s*bari/gi, to: "{manometru_scala} bari" },
  { re: /303040\.0203/g, to: "{manometru_serie}" },
  { re: /minim\s*1\.5/gi, to: "minim {manometru_clasa}" },
  { re: /29\.05\.2025/g, to: "{manometru_verif_metrologica}" },
];

const PER_FILE: Record<string, Rule[]> = {
  "01 PV TRASARE AX CONDUCTA.docx": [
    { re: /\bNr\.\s*1\b/g, to: "Nr. {pv_trasare_nr}" }, PV_DATE(), SEF(), PROIECTANT(),
  ],
  "02 PV SAPATURA LA COTA.docx": [
    { re: /\bNr\.\s*2\b/g, to: "Nr. {pv_sapatura_nr}" }, PV_DATE(), SEF(),
    { re: /[–-]\s*1[,.]10\s*m/gi, to: "- {sapatura_adancime} m" },
    { re: /0\.40\s*m\b/gi, to: "{sapatura_latime} m" },
    { re: /79\.70\s*m\b/gi, to: "{project_length} m" },
  ],
  "03 PV ASTERNERE PAT DE NISIP FUNDUL  SANTULUI.docx": [
    { re: /\bNr\.\s*3\b/g, to: "Nr. {pv_asternere_nr}" }, PV_DATE(), SEF(),
    { re: /0\.40\s*m\b/gi, to: "{sapatura_latime} m" },
    { re: /79\.70\s*ml/gi, to: "{project_length} ml" },
  ],
  "04 PV MONTARE CONDUCTA.docx": [
    { re: /\bNr\.\s*4\b/g, to: "Nr. {pv_montare_nr}" },
    { re: /21\.05\.2025/g, to: "{pv_data}" }, SEF(),
    { re: /PE\s*100\s*SDR\s*11|PE100\s*SDR11/gi, to: "{project_material}" },
    { re: /DN\s*90\s*mm/gi, to: "DN {project_dn} mm" },
    { re: /ELECTROFUZIUNE/gi, to: "{procedeu_sudura}" },
    { re: /568855;\s*568856;\s*568857;\s*PIC04/gi, to: "{sudor_pe_autorizatii}" },
    { re: /schema izometrica nr\.\s*03/gi, to: "schema izometrica nr. {schema_izometrica_nr}" },
  ],
  "05 PV LANSARE IN SANT SI ASTUPARE.docx": [
    { re: /\bNr\.\s*5\b/g, to: "Nr. {pv_lansare_nr}" }, PV_DATE(), SEF(),
  ],
  "06 PV PROBE DE PRESIUNE DE  REZISTENTA.docx": [
    { re: /\bNr\.\s*6\b/g, to: "Nr. {pv_rezistenta_nr}" }, PV_DATE(), SEF(), PROIECTANT(),
    { re: /Dn\s*90\s*mm/gi, to: "Dn {project_dn} mm" },
    { re: /79\.70\s*ml/gi, to: "{project_length} ml" },
    { re: /PE\s*100\s*SDR11/gi, to: "{project_material}" },
    { re: /9\.197/g, to: "{proba_rezistenta_presiune}" },
    { re: /\b170\s*min/gi, to: "{proba_rezistenta_timp} min" },
    { re: /18\.9/g, to: "{proba_rezistenta_temperatura}" },
    ...MANOMETRU,
  ],
  "07 PV PROBE DE PRESIUNE DE  ETANSEITATE.docx": [
    { re: /\bNr\.\s*7\b/g, to: "Nr. {pv_etanseitate_nr}" }, PV_DATE(), SEF(), PROIECTANT(),
    { re: /Dn\s*90\s*mm/gi, to: "Dn {project_dn} mm" },
    { re: /79\.7\s*ml/gi, to: "{project_length} ml" },
    { re: /PE\s*100\s*SDR11/gi, to: "{project_material}" },
    { re: /6\.511/g, to: "{proba_etanseitate_presiune}" },
    { re: /\b1470\s*min/gi, to: "{proba_etanseitate_timp} min" },
    { re: /6\.2\.?\s*°?\s*C/gi, to: "{proba_etanseitate_temperatura} °C" },
    ...MANOMETRU,
  ],
  "8.FD 029 301 PV control in faze det.docx": [
    { re: /\b387\b/g, to: "{nr_inregistrare}" },
    { re: /21\.10\.2025/g, to: "{pv_data}" }, PROIECTANT(),
    { re: /329\s+din\s+15\.09\.2025/gi, to: "{autorizatie_construire_nr} din {autorizatie_construire_data}" },
    { re: /PRIMARIA\s+MAGURELE/gi, to: "{autorizatie_construire_emitent}" },
    { re: /DISTRIGAZ\s+SUD\s+RETELE\s+S\.?\s*R\.?\s*L\.?/gi, to: "{osd_denumire}" },
    { re: /00026301/g, to: "{diriginte_autorizatie}" },
    { re: /00002635\s*\/\s*6384D/gi, to: "{rte_atestat}" },
    { re: /Constantinescu\s+Petre\s+Adrian/gi, to: "{verificator_nume}" },
    { re: /V140900131/g, to: "{verificator_legitimatie}" },
    { re: /PE100\s*SDR11/gi, to: "{project_material}" },
    { re: /Dn\s*90\s*mm/gi, to: "Dn {project_dn} mm" },
    { re: /79\.70\s*ml/gi, to: "{project_length} ml" },
    // Proof-test durations (full phrase, e.g. "2 ore si 50 min" / "24 ore si 30 min")
    { re: /2\s+ore\s+si\s+50\s+min/gi, to: "{timp_proba_rezistenta}" },
    { re: /24\s+ore\s+si\s+30\s+min/gi, to: "{timp_proba_etanseitate}" },
  ],
  "DECIZIE NUMIRE RTE_.docx": [
    { re: /NR\.\s*6\s*\/\s*04\.08\.2023/gi, to: "NR. {rte_decizie_nr} / {rte_decizie_data}" }, ADMIN(),
  ],
  "DECIZIE NUMIRE CQ_.docx": [
    { re: /NR\.\s*9\s*\/\s*04\.08\.2023/gi, to: "NR. {cq_decizie_nr} / {cq_decizie_data}" },
    { re: /Ivan\s+Florin\s+Madalin/gi, to: "{cq_nume}" }, ADMIN(),
  ],
  "DECIZIE NUMIRE SEF DE SANTIER.docx": [
    { re: /NR\.\s*8\s*\/\s*04\.08\.2023/gi, to: "NR. {sef_santier_decizie_nr} / {sef_santier_decizie_data}" }, SEF(), ADMIN(),
  ],
  "0. Convocare FD Str. Seismologilor, nr 35, Loc. Magurele, judetul Ilfov.docx": [
    { re: /Nr\.\s*Iesire:\s*371/gi, to: "Nr. Iesire: {nr_inregistrare}" },
    { re: /15\.10\.2025/g, to: "{data_inregistrare}" }, ADMIN(),
    // firm seat address block
    { re: /CIOROGARLA/gi, to: "{tenant_city}" },
    { re: /str\.\s*ZOE\s+SAMURCASI\s*,?\s*nr\.\s*11A/gi, to: "{tenant_address}" },
    { re: /județul\s+ILFOV\s*,?\s*cod\s+postal\s+77055/gi, to: "județul {tenant_county}, cod postal {tenant_postal}" },
    { re: /0740950808/g, to: "{tenant_phone}" },
    { re: /picinstalgaz@gmail\.com/gi, to: "{tenant_email}" },
    // project address block
    { re: /str\.\s*STR\.\s*SEISMOLOGILOR\s*,?\s*nr\.\s*35/gi, to: "{project_address}" },
    { re: /localitatea\s+MAGURELE/gi, to: "localitatea {project_city}" },
    { re: /judeţul\s+ILFOV/gi, to: "judeţul {project_county}" },
    { re: /21\.10\.2025/g, to: "{pv_data}" },
    { re: /DO_433778\s*\/\s*26\.09\.2025/gi, to: "{nr_comunicare_incepere}" },
    { re: /DO_439314\s*\/\s*30\.09\.2025/gi, to: "{nr_program_control}" },
  ],
};

// Example values that must NOT survive in any template (safety net).
const SENTINELS = [
  /SEISMOLOGILOR/i, /MAGURELE/i, /PIC\s+TERMO/i, /COMAN/i, /GABRIEL/i, /MIHAESCU/i,
  /CALI?OPA|CALIPA/i, /DRAGOS/i, /DISTRIGAZ/i, /CONSTANTINESCU/i, /CIOROGARLA/i,
  /SAMURCASI/i, /C23[34]\/PIC/i, /9\.197/, /6\.511/, /303040/, /568855/, /V140900131/,
  /00026301/, /00002635/, /DO_4337/, /DO_4393/, /picinstalgaz/i,
];

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const xmlUnescape = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

const T_NODE = /(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g;
const P_NODE = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;

function applyToText(text: string, rules: Rule[], hits: Map<RegExp, number>): string {
  for (const r of rules) {
    r.re.lastIndex = 0;
    text = text.replace(r.re, () => { hits.set(r.re, (hits.get(r.re) ?? 0) + 1); return r.to; });
  }
  return text;
}

function concatParagraphText(paraXml: string): string {
  let s = "";
  for (const m of paraXml.matchAll(T_NODE)) s += xmlUnescape(m[2]);
  return s;
}

function applyRules(xml: string, rules: Rule[]): [string, Map<RegExp, number>] {
  const hits = new Map<RegExp, number>(rules.map((r) => [r.re, 0]));
  const out = xml.replace(P_NODE, (para) => {
    // 1. per-node pass — preserves all run formatting
    const p1 = para.replace(T_NODE, (_m, o, b, c) => o + xmlEscape(applyToText(xmlUnescape(b), rules, hits)) + c);
    // 2. any rule still matching across the whole paragraph? (value split across runs)
    const concat = concatParagraphText(p1);
    const split = rules.some((r) => { r.re.lastIndex = 0; return r.re.test(concat); });
    if (!split) return p1;
    // 3. collapse: put rule-applied paragraph text into the first <w:t>, empty the rest
    const merged = applyToText(concat, rules, hits);
    let first = true;
    return p1.replace(T_NODE, (_m, o, _b, c) => {
      if (first) { first = false; return o + xmlEscape(merged) + c; }
      return o + c;
    });
  });
  return [out, hits];
}

function main() {
  const soffice = findSoffice();
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const sources = readdirSync(SRC_DIR).filter(
    (f) => !f.startsWith("~$") && [".doc", ".docx"].includes(extname(f).toLowerCase()),
  );
  console.log(`Converting ${sources.length} files → ${OUT_DIR}\n`);
  for (const f of sources) {
    const src = join(SRC_DIR, f);
    if (extname(f).toLowerCase() === ".docx") copyFileSync(src, join(OUT_DIR, f));
    else execFileSync(soffice, ["--headless", "--convert-to", "docx", "--outdir", OUT_DIR, src], { stdio: "ignore" });
  }

  const files = readdirSync(OUT_DIR).filter((f) => f.toLowerCase().endsWith(".docx") && !f.startsWith("~$"));
  let problems = 0;
  for (const file of files) {
    const rules = [...COMMON, ...(PER_FILE[file] ?? [])];
    const path = join(OUT_DIR, file);
    const zip = new PizZip(readFileSync(path));
    const xml = zip.file("word/document.xml")?.asText();
    if (!xml) { console.warn(`  ⚠ ${file}: no document.xml`); continue; }
    const [updated, hits] = applyRules(xml, rules);
    zip.file("word/document.xml", updated);
    writeFileSync(path, zip.generate({ type: "nodebuffer", compression: "DEFLATE" }));

    const total = [...hits.values()].reduce((a, b) => a + b, 0);
    // per-file rules that matched nothing (actionable)
    const missed = (PER_FILE[file] ?? []).filter((r) => (hits.get(r.re) ?? 0) === 0);
    // leftover example values (safety net)
    const text = concatAll(updated);
    const leftover = SENTINELS.filter((s) => s.test(text));
    console.log(`✓ ${file} — ${total} replacements`);
    for (const r of missed) { console.log(`    · per-file rule 0 hits: ${r.re}`); problems++; }
    for (const s of leftover) { console.log(`    ⚠ LEFTOVER example value: ${s}`); problems++; }
  }
  console.log(`\nDone. ${files.length} templates in "${OUT_DIR}"` + (problems ? ` — ${problems} item(s) to review.` : " — clean."));
}

function concatAll(xml: string): string {
  let s = "";
  for (const m of xml.matchAll(T_NODE)) s += xmlUnescape(m[2]);
  return s;
}

main();
