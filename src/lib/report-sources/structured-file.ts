/**
 * Sursa „fișier structurat": exportul XML/CSV al aplicației analizorului
 * (Seitron Smart Analysis → CSV/XML propriu; testo/Wöhler/MRU → XML „ZIV 2.00";
 * Kane LIVE → CSV). Nu avem mostre, așa că parserul nu cunoaște niciun format:
 * aplatizează fișierul în perechi `etichetă → valoare` și le rezolvă pe cheile
 * noastre prin tabelul comun de aliasuri + mapping-ul firmei (care câștigă).
 *
 *   - XML: walker minimal fără dependențe (fast-xml-parser e doar tranzitiv, din
 *     @aws-sdk). Frunzele cu text devin perechi pe numele frunzei (fără prefixul
 *     de namespace) și pe calea completă; atributele devin perechi `Tag[attr]`
 *     — unitatea (`unit`/`einheit`) se lipește de valoare, ca la Seitron.
 *   - CSV: separator detectat (`;` `,` tab), două forme: antet + un rând de
 *     date (coloană → valoare) sau listă `etichetă;valoare`. Virgula zecimală
 *     devine punct.
 *
 * Toate perechile brute rămân în `analysisData.rawPairs` (max 200) ca ecranul de
 * test din setări să arate ce conține fișierul, pentru mapping.
 */
import {
  HEADER_FIELDS,
  ANALYSIS_META_FIELDS,
  READING_FIELDS,
  emptyParsedRevision,
  type ParsedRevision,
  type ReportSource,
} from "./types.js";
import { aliasKey, isHeaderAliasKey, mappedKey, slugKey } from "./aliases.js";

export const STRUCTURED_FILE_SOURCE_ID = "structured-file";

export const RAW_PAIRS_CAP = 200;

/** O pereche brută din fișier: eticheta (frunză/coloană), calea (XML) și valoarea ca text. */
export interface RawPair {
  label: string;
  path: string;
  value: string;
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[ent] ?? m;
  });
}

const stripNs = (name: string) => name.replace(/^[^:]+:/, "");

const UNIT_ATTRS = new Set(["unit", "units", "einheit", "unita", "unità", "um", "u", "measureunit"]);

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  text: string;
  children: XmlNode[];
}

/**
 * Parser XML minimal: taguri, atribute, text, CDATA; ignoră prolog, comentarii,
 * PI și DOCTYPE. Întoarce rădăcina sau null dacă structura nu e bine formată
 * (taguri neînchise/încrucișate).
 */
export function parseXml(text: string): XmlNode | null {
  const src = text.replace(/^﻿/, "");
  const root: XmlNode = { name: "", attrs: {}, text: "", children: [] };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = src.length;
  let sawElement = false;

  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      stack[stack.length - 1].text += src.slice(i);
      break;
    }
    if (lt > i) stack[stack.length - 1].text += src.slice(i, lt);

    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      if (end < 0) return null;
      i = end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      if (end < 0) return null;
      stack[stack.length - 1].text += src.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      if (end < 0) return null;
      i = end + 2;
      continue;
    }
    if (src.startsWith("<!", lt)) {
      // DOCTYPE (poate avea subset intern între [ ]).
      let depth = 0;
      let j = lt + 2;
      for (; j < n; j++) {
        const c = src[j];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      if (j >= n) return null;
      i = j + 1;
      continue;
    }

    const gt = findTagEnd(src, lt + 1);
    if (gt < 0) return null;
    const raw = src.slice(lt + 1, gt);
    i = gt + 1;

    if (raw[0] === "/") {
      const closing = stripNs(raw.slice(1).trim());
      const top = stack[stack.length - 1];
      if (stack.length < 2 || top.name !== closing) return null;
      stack.pop();
      continue;
    }

    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const m = body.match(/^\s*([^\s/>]+)([\s\S]*)$/);
    if (!m) return null;
    const node: XmlNode = { name: stripNs(m[1]), attrs: {}, text: "", children: [] };
    const attrRe = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(m[2]))) {
      const an = stripNs(am[1]);
      if (an === "xmlns" || am[1].startsWith("xmlns:")) continue;
      node.attrs[an] = decodeXml(am[2] ?? am[3] ?? "");
    }
    stack[stack.length - 1].children.push(node);
    sawElement = true;
    if (!selfClosing) stack.push(node);
  }

  if (stack.length !== 1 || !sawElement) return null;
  if (root.text.trim() && root.children.length === 0) return null;
  return root.children.length === 1 ? root.children[0] : root;
}

/** Sfârșitul tagului deschis la `from` (după `<`), sărind peste `>` din atribute citate. */
function findTagEnd(src: string, from: number): number {
  let quote: string | null = null;
  for (let j = from; j < src.length; j++) {
    const c = src[j];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return j;
    }
  }
  return -1;
}

/** Perechile brute dintr-un arbore XML: frunze cu text + atribute, cu calea completă. */
export function flattenXml(root: XmlNode): RawPair[] {
  const pairs: RawPair[] = [];
  const walk = (node: XmlNode, parentPath: string) => {
    const path = parentPath ? `${parentPath}/${node.name}` : node.name;
    const text = decodeXml(node.text).trim();
    const unitAttr = Object.keys(node.attrs).find((a) => UNIT_ATTRS.has(a.toLowerCase()));
    const unit = unitAttr ? node.attrs[unitAttr].trim() : "";
    if (text && node.children.length === 0) {
      const value = decimalCommaToDot(text);
      pairs.push({ label: node.name, path, value: unit && isNumeric(value) ? `${value} ${unit}` : value });
    }
    for (const [an, av] of Object.entries(node.attrs)) {
      if (!av.trim()) continue;
      pairs.push({ label: `${node.name}[${an}]`, path: `${path}[${an}]`, value: av.trim() });
    }
    for (const child of node.children) walk(child, path);
  };
  walk(root, "");
  return pairs;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export function detectSeparator(lines: string[]): string {
  const candidates = [";", "\t", ","];
  let best = ";";
  let bestScore = -1;
  for (const sep of candidates) {
    const counts = lines.slice(0, 20).map((l) => splitCsvLine(l, sep).length - 1).filter((c) => c > 0);
    if (!counts.length) continue;
    // Consistență: coloane la fel pe toate liniile valorează mai mult decât multe coloane.
    const min = Math.min(...counts);
    const score = counts.length * 10 + min - (Math.max(...counts) - min);
    if (score > bestScore) {
      bestScore = score;
      best = sep;
    }
  }
  return best;
}

function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === sep) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const NUMERIC_RE = /^[-+]?\d+(?:[.,]\d+)?$/;
const NUMERIC_WITH_UNIT_RE = /^[-+]?\d+(?:[.,]\d+)?\s*[^\d\s].{0,8}$/;

const isNumeric = (v: string) => NUMERIC_RE.test(v.trim());
const isNumericish = (v: string) => NUMERIC_RE.test(v.trim()) || NUMERIC_WITH_UNIT_RE.test(v.trim());

/** „4,5" → „4.5"; „4,5 %" → „4.5 %"; lasă textul neatins dacă nu începe cu număr cu virgulă. */
function decimalCommaToDot(v: string): string {
  return v.replace(/^([-+]?\d+),(\d+)(?=\s|$|[^\d,])/, "$1.$2");
}

/** Perechile brute dintr-un CSV (antet + rând de date sau listă cheie;valoare). */
export function flattenCsv(text: string): RawPair[] {
  const lines = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (lines.length < 1) return [];
  const sep = detectSeparator(lines);
  const rows = lines.map((l) => splitCsvLine(l, sep));

  const pairs: RawPair[] = [];
  const push = (label: string, value: string) => {
    const l = label.trim();
    const v = decimalCommaToDot(value.trim());
    if (!l || !v) return;
    pairs.push({ label: l, path: l, value: v });
  };

  // Listă cheie;valoare: majoritatea rândurilor au 2 coloane (sau 3 = cheie;valoare;unitate),
  // prima coloană e text, nu număr.
  const twoCol = rows.filter((r) => r.length >= 2 && r.length <= 3 && r[0] && !isNumeric(r[0]));
  const headerRow = rows[0];
  const looksLikeTable =
    rows.length >= 2 &&
    headerRow.length >= 3 &&
    headerRow.every((h) => h && !isNumeric(h)) &&
    rows.slice(1).some((r) => r.length >= Math.min(3, headerRow.length) && r.some(isNumericish));

  if (looksLikeTable) {
    // Primul rând de date câștigă (a doua analiză nu suprascrie prima); liniile
    // „unitate" (toate celulele fără cifre) de sub antet sunt lipite de etichetă.
    let unitRow: string[] | null = null;
    let dataRow: string[] | null = null;
    for (const r of rows.slice(1)) {
      if (!r.some((c) => /\d/.test(c))) {
        if (!unitRow) unitRow = r;
        continue;
      }
      dataRow = r;
      break;
    }
    if (dataRow) {
      headerRow.forEach((h, idx) => {
        const v = dataRow![idx] ?? "";
        if (!v) return;
        const unit = unitRow?.[idx]?.trim();
        push(h, unit && isNumeric(v) ? `${v} ${unit}` : v);
      });
      return pairs;
    }
  }

  if (twoCol.length >= Math.max(2, Math.floor(rows.length * 0.6))) {
    for (const r of twoCol) {
      const unit = r[2]?.trim();
      push(r[0], unit && isNumeric(r[1]) ? `${r[1]} ${unit}` : r[1]);
    }
    return pairs;
  }

  // Formă necunoscută: tot ce arată a „etichetă, valoare" pe un rând.
  for (const r of rows) {
    if (r.length >= 2 && r[0] && !isNumeric(r[0]) && r[1]) push(r[0], r[1]);
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Detecție + rezolvare
// ---------------------------------------------------------------------------

const looksLikeXml = (text: string) => /^\s*(?:﻿)?\s*<(?:\?xml|[A-Za-z_])/.test(text);

/** Perechile brute din text, după forma lui; `kind` spune ce s-a recunoscut. */
export function extractPairs(text: string): { kind: "xml" | "csv" | null; pairs: RawPair[] } {
  if (!text || !text.trim()) return { kind: null, pairs: [] };
  if (looksLikeXml(text)) {
    const root = parseXml(text);
    if (root) return { kind: "xml", pairs: flattenXml(root) };
    return { kind: null, pairs: [] };
  }
  const pairs = flattenCsv(text);
  return { kind: pairs.length ? "csv" : null, pairs };
}

const DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$|^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:[T\s].*)?$/;

function parseDateValue(v: string): Date | null {
  const m = v.trim().match(DATE_RE);
  if (!m) return null;
  if (m[1]) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const y = m[6].length === 2 ? 2000 + Number(m[6]) : Number(m[6]);
  return new Date(y, Number(m[5]) - 1, Number(m[4]));
}

const TIME_RE = /\b(\d{1,2}):(\d{2})(?::\d{2})?\b/;

/** Etichetele pe care le cunoaștem fără mapping (pentru UI) — chei de antet + citiri. */
const SOURCE_FIELDS = [...HEADER_FIELDS, ...ANALYSIS_META_FIELDS, ...READING_FIELDS];

const READING_KEYS = new Set<string>(READING_FIELDS);

/**
 * Cheia noastră pentru o pereche brută: mapping-ul firmei pe cale sau etichetă
 * > alias pe etichetă > alias pe ultimele două segmente ale căii (ex.
 * `Kunde/Name`) > slug din etichetă.
 */
function resolvePair(pair: RawPair, mapping?: Record<string, string>): { key: string; known: boolean } {
  const mapped = mappedKey(pair.path, mapping) ?? mappedKey(pair.label, mapping);
  if (mapped) return { key: mapped, known: true };
  const alias = aliasKey(pair.label);
  if (alias) return { key: alias, known: true };
  const segs = pair.path.split("/");
  if (segs.length >= 2) {
    const tail = aliasKey(`${segs[segs.length - 2]} ${segs[segs.length - 1]}`);
    if (tail) return { key: tail, known: true };
  }
  return { key: slugKey(pair.label), known: false };
}

/** Transformă perechile brute în `ParsedRevision` (prima pereche pe o cheie câștigă). */
export function fromPairs(pairs: RawPair[], rawText: string, mapping?: Record<string, string>): ParsedRevision {
  const out = emptyParsedRevision(rawText);
  const readings: Record<string, string> = {};
  const meta: Record<string, string> = {};
  const headerSet = new Set<string>();
  let fallbackDate: Date | null = null;
  let fallbackSerial: string | null = null;

  const setHeader = (key: string, value: string): boolean => {
    if (headerSet.has(key)) return false;
    switch (key) {
      case "revisionDate": {
        const d = parseDateValue(value);
        if (!d) return false;
        out.revisionDate = d;
        const t = value.match(TIME_RE);
        if (t && !meta.ora) meta.ora = `${t[1].padStart(2, "0")}:${t[2]}`;
        break;
      }
      case "time": {
        const t = value.match(TIME_RE);
        if (!t) return false;
        meta.ora = `${t[1].padStart(2, "0")}:${t[2]}`;
        break;
      }
      case "location": out.location = value; break;
      case "clientName": out.clientName = value; break;
      case "clientSurname": out.clientSurname = value; break;
      case "clientAddress": out.clientAddress = value; break;
      case "clientPhone": out.clientPhone = value; break;
      case "clientEmail": out.clientEmail = value; break;
      case "equipmentName": out.equipmentName = value; break;
      case "equipmentSerial": out.equipmentSerial = value; break;
      case "operatorName": out.operator.name = value; break;
      case "operatorAddress": out.operator.address = value; break;
      case "operatorPhone": out.operator.phone = value; break;
      case "operatorEmail": out.operator.email = value; break;
      case "analyzerName": out.analyzer.name = value; break;
      case "analyzerSerial": out.analyzer.serial = value; break;
      case "fuel": meta.combustibil = value; break;
      case "altitude": meta.altitudine = value; break;
      case "humidity": meta.umiditate = value; break;
      default: return false;
    }
    headerSet.add(key);
    return true;
  };

  for (const pair of pairs) {
    const value = pair.value.trim();
    if (!value || value === "---" || value === "-" || /^n\/?a$/i.test(value)) continue;
    const { key, known } = resolvePair(pair, mapping);

    if (isHeaderAliasKey(key)) {
      setHeader(key, value);
      continue;
    }
    if (READING_KEYS.has(key) || known) {
      if (!(key in readings)) readings[key] = value;
      continue;
    }
    // Necunoscută: o păstrăm pe slug doar dacă e o valoare numerică (restul e
    // zgomot de structură — rămâne oricum în rawPairs).
    if (isNumericish(value) && !(key in readings)) readings[key] = value;

    // Rezerve când nicio etichetă nu a fost recunoscută ca dată / serie.
    if (!fallbackDate && /dat|date|zeit|time/i.test(pair.label)) fallbackDate = parseDateValue(value);
    if (!fallbackSerial && /seri|s\/n|^sn$|matric/i.test(pair.label) && /\d/.test(value)) fallbackSerial = value;
  }

  if (!out.revisionDate && fallbackDate) out.revisionDate = fallbackDate;
  if (!out.analyzer.serial && fallbackSerial) out.analyzer.serial = fallbackSerial;

  const analysisData: Record<string, unknown> = { ...meta };
  if (Object.keys(readings).length) analysisData.readings = readings;
  analysisData.rawPairs = pairs.slice(0, RAW_PAIRS_CAP).map((p) => ({ label: p.path, value: p.value }));
  if (pairs.length > RAW_PAIRS_CAP) analysisData.rawPairsTruncated = pairs.length - RAW_PAIRS_CAP;
  out.analysisData = analysisData;
  return out;
}

export const structuredFileSource: ReportSource = {
  id: STRUCTURED_FILE_SOURCE_ID,
  label: "Fișier XML/CSV (analizor)",
  kind: "builtin",
  fields: SOURCE_FIELDS,
  detect(text) {
    if (!text) return 0;
    const { kind, pairs } = extractPairs(text);
    if (!kind) return 0;
    const numeric = pairs.filter((p) => isNumericish(p.value)).length;
    if (numeric < 3) return 0;
    return kind === "xml" ? 0.9 : 0.7;
  },
  async parse({ text, mapping }) {
    const rawText = text ?? "";
    const { kind, pairs } = extractPairs(rawText);
    if (!kind) {
      const empty = emptyParsedRevision(rawText);
      empty.analysisData = { _warning: "not_structured" };
      return empty;
    }
    const parsed = fromPairs(pairs, rawText, mapping);
    parsed.analysisData.fileKind = kind;
    return parsed;
  },
};
