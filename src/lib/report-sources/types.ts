/**
 * Surse de rapoarte de analiză (PDF-uri de la analizoare de ardere etc.).
 *
 * O „sursă" știe să recunoască un tip de raport din textul extras (`detect`) și
 * să-l transforme în forma comună `ParsedRevision` (`parse`). Registrul din
 * `index.ts` alege sursa potrivită; configurația per firmă
 * (`settingsJson.reportSources`) poate forța una anume sau poate lăsa detecția
 * automată.
 *
 * `ParsedRevision` e definit aici (fără importuri) ca să nu apară cicluri:
 * parserul Seitron îl re-exportă sub același nume pentru compatibilitate.
 */

export interface ParsedRevision {
  revisionDate: Date | null;
  location: string | null;
  clientName: string | null;
  clientSurname: string | null;
  clientAddress: string | null;
  clientPhone: string | null;
  clientEmail: string | null;
  equipmentName: string | null;
  equipmentSerial: string | null;
  operator: {
    name: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
  };
  analyzer: {
    name: string | null;
    serial: string | null;
  };
  /**
   * Metadate + citiri. Convenție (cea a parserului Seitron, citită și de
   * generatorul ISCIR): `readings` = { tGaz, tAer, o2, co2, co, ... } cu valori
   * ca text inclusiv unitatea („52.7 °C"); `combustibil`, `altitudine`,
   * `umiditate`, `ora` la nivelul de sus; `_source` = id-ul sursei care a produs
   * datele.
   */
  analysisData: Record<string, unknown>;
  rawText: string;
}

export type ReportSourceKind = "builtin" | "ai" | "attach";

export interface ReportSourceParseInput {
  buffer: Buffer;
  /** Textul extras cu pdftotext (poate fi gol pentru PDF-uri scanate). */
  text: string;
  /** Etichetă tipărită → cheia noastră (ex. `{ "CO": "co" }`); din setările firmei. */
  mapping?: Record<string, string>;
}

export interface ReportSource {
  id: string;
  label: string;
  kind: ReportSourceKind;
  /** Cheile pe care le poate produce (câmpuri de antet + chei din `readings`). */
  fields: string[];
  /** Cât de sigur e că textul e un raport de tipul lui: 0..1. */
  detect(text: string): number;
  parse(input: ReportSourceParseInput): Promise<ParsedRevision>;
}

/** Un `ParsedRevision` gol — doar textul brut. */
export function emptyParsedRevision(rawText: string): ParsedRevision {
  return {
    revisionDate: null,
    location: null,
    clientName: null,
    clientSurname: null,
    clientAddress: null,
    clientPhone: null,
    clientEmail: null,
    equipmentName: null,
    equipmentSerial: null,
    operator: { name: null, address: null, phone: null, email: null },
    analyzer: { name: null, serial: null },
    analysisData: {},
    rawText,
  };
}

/** Câmpurile de antet pe care le poate avea orice sursă (chei plate, pentru UI). */
export const HEADER_FIELDS = [
  "revisionDate",
  "location",
  "clientName",
  "clientSurname",
  "clientAddress",
  "clientPhone",
  "clientEmail",
  "equipmentName",
  "equipmentSerial",
  "operatorName",
  "operatorAddress",
  "operatorPhone",
  "operatorEmail",
  "analyzerName",
  "analyzerSerial",
] as const;

/** Metadatele analizei (la nivelul de sus în `analysisData`). */
export const ANALYSIS_META_FIELDS = ["combustibil", "altitudine", "umiditate", "ora"] as const;

/**
 * Cheile din `analysisData.readings` folosite de documentul ISCIR și de
 * prefill-ul wizard-ului. O sursă nouă trebuie să scrie pe aceste chei (prin
 * mapping) ca datele să ajungă în document.
 */
export const READING_FIELDS = [
  "tGaz",
  "tAer",
  "o2",
  "co2",
  "co",
  "coCorr",
  "ec",
  "lambda",
  "excessAir",
  "dT",
  "qs",
  "es",
  "et",
  "no",
  "nox",
  "noCorr",
  "noxCorr",
  "pi",
  // Nu le produce analizorul Seitron, dar le pot aduce alte surse (prin mapping)
  // și le folosește prefill-ul wizard-ului.
  "draft",
  "gasPressureRamp",
  "gasPressureBurner",
] as const;

export type ReadingField = (typeof READING_FIELDS)[number];
