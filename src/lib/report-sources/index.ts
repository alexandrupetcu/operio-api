/**
 * Registrul surselor de rapoarte. Ordinea contează doar la egalitate de scor
 * (prima câștigă); `attach-only` e rezerva când nimeni nu recunoaște textul.
 */
import { seitronPdfSource, SEITRON_SOURCE_ID } from "./seitron-pdf.js";
import { structuredFileSource, STRUCTURED_FILE_SOURCE_ID } from "./structured-file.js";
import { genericAiPdfSource, GENERIC_AI_SOURCE_ID } from "./generic-ai-pdf.js";
import { attachOnlySource, ATTACH_ONLY_SOURCE_ID } from "./attach-only.js";
import type { ReportSource } from "./types.js";

export * from "./types.js";
export {
  extractPdfText,
  extractText,
  reportFileKind,
  REPORT_FILE_MIMETYPES,
  REPORT_FILE_CANONICAL_MIME,
  ACCEPTED_REPORT_FILES_MESSAGE,
  type ReportFileKind,
} from "./pdf-text.js";
export { SEITRON_SOURCE_ID, STRUCTURED_FILE_SOURCE_ID, GENERIC_AI_SOURCE_ID, ATTACH_ONLY_SOURCE_ID };

// Fișierele structurate (XML/CSV) stau înaintea sursei AI: la același text
// câștigă parserul determinist, nu modelul.
export const REPORT_SOURCES: readonly ReportSource[] = [
  seitronPdfSource,
  structuredFileSource,
  genericAiPdfSource,
  attachOnlySource,
];

export function getSource(id: string): ReportSource | undefined {
  return REPORT_SOURCES.find((s) => s.id === id);
}

export function isSourceId(id: unknown): id is string {
  return typeof id === "string" && REPORT_SOURCES.some((s) => s.id === id);
}

/** Sursa cu cel mai mare scor; `attach-only` (scor 0) când nimic nu se potrivește. */
export function detectSource(text: string): { source: ReportSource; score: number } {
  let best: { source: ReportSource; score: number } = { source: attachOnlySource, score: 0 };
  for (const source of REPORT_SOURCES) {
    if (source.id === ATTACH_ONLY_SOURCE_ID) continue;
    let score = 0;
    try {
      score = source.detect(text);
    } catch {
      score = 0;
    }
    if (score > best.score) best = { source, score };
  }
  return best;
}

/** Forma publică a unei surse (fără funcții) — pentru setări și răspunsuri API. */
export function describeSource(source: ReportSource) {
  return { id: source.id, label: source.label, kind: source.kind, fields: source.fields };
}

/**
 * `{ id, label }` pentru o revizie salvată: `analysisData._source`, iar pentru
 * rândurile vechi (dinaintea registrului) Seitron dacă au date de analizor.
 */
export function revisionSource(revision: {
  analysisData: unknown;
  analyzerName?: string | null;
}): { id: string; label: string } | null {
  const data =
    revision.analysisData && typeof revision.analysisData === "object"
      ? (revision.analysisData as Record<string, unknown>)
      : null;
  const stored = data?._source;
  const source =
    (typeof stored === "string" ? getSource(stored) : undefined) ??
    (revision.analyzerName || (data?.readings && typeof data.readings === "object")
      ? seitronPdfSource
      : undefined);
  return source ? { id: source.id, label: source.label } : null;
}
