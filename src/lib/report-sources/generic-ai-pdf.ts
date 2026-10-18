import OpenAI from "openai";
import { env } from "../../config/env.js";
import {
  ANALYSIS_META_FIELDS,
  HEADER_FIELDS,
  READING_FIELDS,
  emptyParsedRevision,
  type ParsedRevision,
  type ReportSource,
} from "./types.js";

export const GENERIC_AI_SOURCE_ID = "generic-ai-pdf";

/** Linii „valoare + unitate" — semnătura minimă a unui raport de analiză. */
const NUMERIC_UNIT_LINE = /-?\d+(?:[.,]\d+)?\s*(?:%|ppm|°\s?C|mbar|hPa|Pa)\b/;

/**
 * Etichete frecvente pe rapoartele altor analizoare (Testo, Kane, Wöhler, MRU…)
 * → cheile noastre. Mapping-ul firmei (`sourceMappings[generic-ai-pdf]`) are
 * prioritate; ce nu e nici acolo, nici aici, ajunge pe o cheie slug din etichetă
 * (păstrată, ca să nu se piardă nimic din raport).
 */
const DEFAULT_LABEL_ALIASES: Record<string, string> = {
  "t gaz": "tGaz", "tgas": "tGaz", "t gas": "tGaz", "flue temp": "tGaz", "flue gas temp": "tGaz",
  "ft": "tGaz", "fgt": "tGaz", "temperatura gaze": "tGaz", "temp gaze arse": "tGaz", "stack temp": "tGaz",
  "t aer": "tAer", "tair": "tAer", "t air": "tAer", "ambient temp": "tAer", "at": "tAer", "temperatura aer": "tAer",
  "o2": "o2", "oxygen": "o2", "oxigen": "o2",
  "co2": "co2",
  "co": "co", "carbon monoxide": "co", "monoxid de carbon": "co",
  "co(0%)": "coCorr", "co (0%)": "coCorr", "co 0%": "coCorr", "co corr": "coCorr", "co corectat": "coCorr",
  "co undiluted": "coCorr", "cou": "coCorr",
  "lambda": "lambda", "λ": "lambda", "l": "lambda", "l;n": "lambda",
  "excess air": "excessAir", "exces aer": "excessAir", "excesaer": "excessAir", "ea": "excessAir",
  "dt": "dT", "δt": "dT", "delta t": "dT", "net temp": "dT",
  "qs": "qs", "qa": "qs", "stack loss": "qs", "pierderi": "qs", "losses": "qs",
  "es": "es", "eta": "es", "sensible efficiency": "es",
  "et": "et", "eff": "et", "efficiency": "et", "randament": "et", "eficienta": "et", "eficiență": "et",
  "no": "no", "nox": "nox", "no(0%)": "noCorr", "nox(0%)": "noxCorr",
  "pi": "pi", "poison index": "pi",
  "draft": "draft", "tiraj": "draft", "draught": "draft", "dp": "draft", "pressure": "draft",
  "presiune rampa": "gasPressureRamp", "presiune rampă": "gasPressureRamp", "p rampa": "gasPressureRamp",
  "presiune arzator": "gasPressureBurner", "presiune arzător": "gasPressureBurner", "p arzator": "gasPressureBurner",
};

// „CO(0.0%)", „CO (0 %)" → „co(0%)" ca să prindă aliasul corectat-la-0%-O2.
const normalizeLabel = (label: string) =>
  label
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*\(\s*0(?:[.,]0+)?\s*%\s*\)/g, "(0%)");

const slugKey = (label: string) =>
  normalizeLabel(label)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "value";

/** Cheia noastră pentru o etichetă tipărită: mapping-ul firmei > aliasuri > slug. */
export function resolveReadingKey(label: string, mapping?: Record<string, string>): string {
  if (mapping) {
    const exact = mapping[label] ?? mapping[label.trim()];
    if (exact) return exact;
    const norm = normalizeLabel(label);
    for (const [k, v] of Object.entries(mapping)) {
      if (normalizeLabel(k) === norm) return v;
    }
  }
  return DEFAULT_LABEL_ALIASES[normalizeLabel(label)] ?? slugKey(label);
}

const MAX_TEXT_CHARS = 40_000;

const SYSTEM_PROMPT = `Ești un asistent care extrage date structurate din rapoarte de analiză a gazelor de ardere (analizoare de ardere pentru centrale termice: Seitron, Testo, Kane, Wöhler, MRU etc.). Primești textul extras dintr-un PDF (coloanele sunt păstrate prin spații multiple). Răspunzi DOAR cu un obiect JSON, fără explicații.

Schema răspunsului:
{
  "revisionDate": "YYYY-MM-DD" | null,      // data analizei
  "time": "HH:MM" | null,
  "location": string | null,                 // localitatea / locul analizei
  "clientName": string | null,               // numele clientului (nume de familie sau firmă)
  "clientSurname": string | null,            // prenumele clientului, dacă e separat
  "clientAddress": string | null,
  "clientPhone": string | null,
  "clientEmail": string | null,
  "equipmentName": string | null,            // marca + modelul centralei
  "equipmentSerial": string | null,
  "operator": { "name": string|null, "address": string|null, "phone": string|null, "email": string|null },  // firma/tehnicianul care a făcut analiza
  "analyzer": { "name": string|null, "serial": string|null },   // modelul și seria analizorului
  "fuel": string | null,                     // combustibilul (ex. "Gaz Natural")
  "altitude": string | null,
  "humidity": string | null,
  "readings": { "<eticheta exact așa cum e tipărită>": "<valoare cu unitate, ex. '52 ppm'>" }
}

Reguli: valorile din "readings" păstrează unitatea tipărită; dacă raportul are mai multe analize, ia prima (sau pe cea marcată ca finală). Placeholder-ele goale ("---", "-", "n/a") devin null. Nu inventa valori.`;

interface AiExtraction {
  revisionDate?: string | null;
  time?: string | null;
  location?: string | null;
  clientName?: string | null;
  clientSurname?: string | null;
  clientAddress?: string | null;
  clientPhone?: string | null;
  clientEmail?: string | null;
  equipmentName?: string | null;
  equipmentSerial?: string | null;
  operator?: { name?: string | null; address?: string | null; phone?: string | null; email?: string | null } | null;
  analyzer?: { name?: string | null; serial?: string | null } | null;
  fuel?: string | null;
  altitude?: string | null;
  humidity?: string | null;
  readings?: Record<string, unknown> | null;
}

const str = (v: unknown): string | null => {
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t === "---" || t === "-" || /^n\/?a$/i.test(t)) return null;
  return t;
};

function parseIsoDate(v: unknown): Date | null {
  const s = str(v);
  if (!s) return null;
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const dmy = s.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (dmy) {
    const y = dmy[3].length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3]);
    return new Date(y, Number(dmy[2]) - 1, Number(dmy[1]));
  }
  return null;
}

/** Transformă răspunsul modelului în `ParsedRevision`, aplicând mapping-ul etichetelor. */
export function fromAiExtraction(
  ai: AiExtraction,
  rawText: string,
  mapping?: Record<string, string>,
): ParsedRevision {
  const out = emptyParsedRevision(rawText);
  out.revisionDate = parseIsoDate(ai.revisionDate);
  out.location = str(ai.location);
  out.clientName = str(ai.clientName);
  out.clientSurname = str(ai.clientSurname);
  out.clientAddress = str(ai.clientAddress);
  out.clientPhone = str(ai.clientPhone);
  out.clientEmail = str(ai.clientEmail);
  out.equipmentName = str(ai.equipmentName);
  out.equipmentSerial = str(ai.equipmentSerial);
  out.operator = {
    name: str(ai.operator?.name),
    address: str(ai.operator?.address),
    phone: str(ai.operator?.phone),
    email: str(ai.operator?.email),
  };
  out.analyzer = { name: str(ai.analyzer?.name), serial: str(ai.analyzer?.serial) };

  const analysisData: Record<string, unknown> = {};
  const fuel = str(ai.fuel);
  if (fuel) analysisData.combustibil = fuel;
  const altitude = str(ai.altitude);
  if (altitude) analysisData.altitudine = altitude;
  const humidity = str(ai.humidity);
  if (humidity) analysisData.umiditate = humidity;
  const time = str(ai.time);
  if (time) analysisData.ora = time;

  const readings: Record<string, string> = {};
  if (ai.readings && typeof ai.readings === "object") {
    for (const [label, raw] of Object.entries(ai.readings)) {
      const value = str(raw);
      if (!value) continue;
      const key = resolveReadingKey(label, mapping);
      // Prima etichetă câștigă — a doua analiză nu suprascrie prima.
      if (!(key in readings)) readings[key] = value;
    }
  }
  if (Object.keys(readings).length > 0) analysisData.readings = readings;
  out.analysisData = analysisData;
  return out;
}

function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  return first >= 0 && last > first ? candidate.slice(first, last + 1) : candidate;
}

export const genericAiPdfSource: ReportSource = {
  id: GENERIC_AI_SOURCE_ID,
  label: "Extragere AI (orice analizor)",
  kind: "ai",
  fields: [...HEADER_FIELDS, ...ANALYSIS_META_FIELDS, ...READING_FIELDS],
  detect(text) {
    if (!text) return 0;
    let numericLines = 0;
    for (const line of text.split("\n")) {
      if (NUMERIC_UNIT_LINE.test(line) && ++numericLines >= 3) return 0.3;
    }
    return 0;
  },
  async parse({ text, mapping }) {
    const rawText = text ?? "";
    // Fără cheie sau fără text (PDF scanat) → eșec „moale": fișierul se
    // atașează, citirile rămân goale, iar motivul rămâne în analysisData.
    if (!env.OPENAI_API_KEY) {
      const empty = emptyParsedRevision(rawText);
      empty.analysisData = { _warning: "openai_key_missing" };
      return empty;
    }
    if (!rawText.trim()) {
      const empty = emptyParsedRevision(rawText);
      empty.analysisData = { _warning: "no_text" };
      return empty;
    }

    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const mappingHint =
      mapping && Object.keys(mapping).length
        ? `\n\nEtichete cunoscute pe acest tip de raport (folosește-le exact așa în "readings" când le întâlnești): ${Object.keys(mapping).join(", ")}.`
        : "";
    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0,
      max_tokens: 2000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Textul raportului:${mappingHint}\n\n"""\n${rawText.slice(0, MAX_TEXT_CHARS)}\n"""`,
        },
      ],
    });
    const content = response.choices[0]?.message?.content ?? "";
    let ai: AiExtraction;
    try {
      ai = JSON.parse(extractJsonObject(content)) as AiExtraction;
    } catch {
      const empty = emptyParsedRevision(rawText);
      empty.analysisData = { _warning: "ai_invalid_json" };
      return empty;
    }
    return fromAiExtraction(ai ?? {}, rawText, mapping);
  },
};
