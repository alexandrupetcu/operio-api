import { parseRevisionText } from "../../modules/equipment-revisions/revision-pdf-parser.js";
import {
  ANALYSIS_META_FIELDS,
  HEADER_FIELDS,
  type ReportSource,
} from "./types.js";

export const SEITRON_SOURCE_ID = "seitron-pdf";

/**
 * Etichetele pe care le tipărește raportul Chemist (pdftotext -layout). Scorul
 * e fracția găsită: un raport complet dă 1.0, unul trunchiat (fără bloc de
 * analize) ~0.5, un PDF oarecare 0.
 */
const MARKERS: RegExp[] = [
  /\bOperator:/,
  /\bEquipment:/,
  /\bClient address:/,
  /\bClient phone:/,
  /\bAnalyses:/,
  /\bChemist\b/,
  /\bNumar Serial\b/,
  /\bCombustibil\b/,
  /\bAnaliza\s+\d/,
  /\bExcesAer\b/,
];

/** Cheile din `readings` pe care le scoate parserul regex. */
const SEITRON_READING_KEYS = [
  "tGaz", "tAer", "o2", "co2", "co", "coCorr", "ec", "lambda", "excessAir",
  "dT", "qs", "es", "et", "no", "nox", "noCorr", "noxCorr", "pi", "draft",
];

export const seitronPdfSource: ReportSource = {
  id: SEITRON_SOURCE_ID,
  label: "Seitron Chemist (PDF analizor)",
  kind: "builtin",
  fields: [...HEADER_FIELDS, ...ANALYSIS_META_FIELDS, ...SEITRON_READING_KEYS],
  detect(text) {
    if (!text) return 0;
    const hits = MARKERS.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
    return Math.min(1, hits / MARKERS.length);
  },
  async parse({ text }) {
    return parseRevisionText(text);
  },
};
