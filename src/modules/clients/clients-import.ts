import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import ExcelJS from "exceljs";
import { z } from "zod";
import { normalizePlace } from "../anaf/anaf-geo.js";

/**
 * Import de clienți din Excel/CSV (onboarding): firma vine cu evidența ei veche —
 * o listă cu nume, telefon, adresă, POD și data ultimei revizii — și o aduce
 * dintr-o dată în Operio. Două etape: `preview` (antet + primele rânduri +
 * maparea propusă a coloanelor) și `import` (maparea confirmată de utilizator).
 *
 * Pe lângă Client + adresă, un rând poate produce o GasInstallation (POD / cod
 * client / data ultimei verificări a instalației) și o centrală cu o revizie la
 * data dată — ca alertele de scadență din panou să pornească din prima zi.
 */

export const TARGET_FIELDS = [
  "name",
  "phone",
  "email",
  "cui",
  "address",
  "city",
  "county",
  "pod",
  "codClient",
  "lastRevisionDate",
  "lastInstalatieDate",
  "notes",
] as const;
export type TargetField = (typeof TARGET_FIELDS)[number];
export type ColumnMapping = Record<TargetField, number | null>;

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 2_000;
const BATCH_SIZE = 100;
const MAX_ERRORS = 50;
const PREVIEW_ROWS = 5;

export const mappingSchema = z.object(
  Object.fromEntries(TARGET_FIELDS.map((f) => [f, z.number().int().min(0).nullable().optional()])) as Record<
    TargetField,
    z.ZodOptional<z.ZodNullable<z.ZodNumber>>
  >,
);

export interface ParsedSheet {
  headers: string[];
  /** Rândurile de date (fără antet), fiecare cu exact `headers.length` celule. */
  rows: string[][];
}

// ── Parsare fișier ──────────────────────────────────────────────────────────

function isXlsx(filename: string, mimetype: string, buffer: Buffer): boolean {
  const name = filename.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) return true;
  if (mimetype.includes("spreadsheetml")) return true;
  // Arhivă ZIP (semnătura „PK”) = Office Open XML.
  return buffer.length > 3 && buffer[0] === 0x50 && buffer[1] === 0x4b && !name.endsWith(".csv");
}

/** Celulă ExcelJS → text. Datele tipizate ies ISO (yyyy-mm-dd), formulele prin rezultat. */
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((r) => r.text).join("").trim();
    if ("result" in o) return cellText(o.result as ExcelJS.CellValue);
    if (typeof o.text === "string") return o.text.trim();
    if ("hyperlink" in o && typeof o.text === "object") return cellText(o.text as ExcelJS.CellValue);
    if ("error" in o) return "";
  }
  return String(v).trim();
}

async function parseXlsx(buffer: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const out: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = Array.isArray(row.values) ? (row.values as ExcelJS.CellValue[]) : [];
    // `row.values` e indexat de la 1 (poziția 0 e goală).
    const cells = values.slice(1).map(cellText);
    if (cells.some((c) => c !== "")) out.push(cells);
  });
  return out;
}

/** Textul CSV: UTF-8 (cu/fără BOM) sau, dacă nu e UTF-8 valid, Windows-1250 (export Excel RO vechi). */
function decodeCsv(buffer: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    text = new TextDecoder("windows-1250").decode(buffer);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function detectDelimiter(firstLine: string): string {
  const counts = [";", ",", "\t"].map((d) => ({ d, n: firstLine.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ",";
}

/** Parser CSV cu ghilimele („" dublat ca escape, rânduri noi în interiorul câmpului). */
function parseCsv(buffer: Buffer): string[][] {
  const text = decodeCsv(buffer);
  const firstLineEnd = text.search(/\r?\n/);
  const delimiter = detectDelimiter(firstLineEnd === -1 ? text : text.slice(0, firstLineEnd));

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field.trim());
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field.trim());
      field = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field.trim());
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

export class ImportFileError extends Error {}

export async function parseUpload(buffer: Buffer, filename: string, mimetype: string): Promise<ParsedSheet> {
  if (buffer.length === 0) throw new ImportFileError("Fișierul este gol");
  if (buffer.length > MAX_FILE_BYTES) throw new ImportFileError("Fișierul depășește 5 MB");
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xls") && !isXlsx(filename, mimetype, buffer)) {
    throw new ImportFileError("Formatul .xls (Excel 97-2003) nu este acceptat — salvați fișierul ca .xlsx sau .csv");
  }

  let raw: string[][];
  try {
    raw = isXlsx(filename, mimetype, buffer) ? await parseXlsx(buffer) : parseCsv(buffer);
  } catch {
    throw new ImportFileError("Fișierul nu a putut fi citit — folosiți .xlsx sau .csv");
  }
  if (raw.length === 0) throw new ImportFileError("Fișierul nu conține date");

  const width = Math.max(...raw.map((r) => r.length));
  const pad = (r: string[]) => (r.length === width ? r : [...r, ...Array(width - r.length).fill("")]);
  const headers = pad(raw[0]).map((h, i) => h || `Coloana ${i + 1}`);
  const rows = raw.slice(1).map(pad);
  if (rows.length > MAX_ROWS) throw new ImportFileError(`Fișierul are ${rows.length} rânduri — maximum ${MAX_ROWS} la un import`);
  return { headers, rows };
}

// ── Maparea propusă a coloanelor ────────────────────────────────────────────

/** „Telefon mobil” → „telefon mobil”; fără diacritice, punctuație sau spații duble. */
export function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[şș]/g, "s").replace(/[ţț]/g, "t")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Ordinea contează: primul câmp al cărui tipar se potrivește câștigă coloana. */
const HEADER_PATTERNS: [TargetField, RegExp][] = [
  // Datele înaintea câmpurilor generice: „data ultimei revizii” conține și „revizie”.
  ["lastInstalatieDate", /\b(verificare|verif|revizie instalatie|revizia instalatiei|ultima verificare|data verificarii|instalatie)\b/],
  ["lastRevisionDate", /\b(ultima revizie|revizie centrala|revizia centralei|data reviziei|data revizie|revizie|centrala|ultima rev)\b/],
  ["pod", /\b(pod|cod tehnic|cod loc consum|clc|nlc)\b/],
  ["codClient", /\b(cod client|cod abonat|nr client|id client)\b/],
  ["cui", /\b(cui|cif|cod fiscal|cod unic)\b/],
  ["email", /\b(e ?mail|mail|adresa email)\b/],
  ["phone", /\b(telefon|tel|mobil|phone|nr tel|numar telefon)\b/],
  ["county", /\b(judet|jud|county)\b/],
  ["city", /\b(localitate|oras|orasul|municipiu|comuna|city|sector)\b/],
  ["address", /\b(adresa|adresa completa|strada|str|domiciliu|sediu|address)\b/],
  ["notes", /\b(observatii|obs|note|notes|mentiuni|comentarii)\b/],
  ["name", /\b(nume|nume si prenume|nume client|client|denumire|denumirea|firma|beneficiar|name|titular|abonat)\b/],
];

export function suggestMapping(headers: string[]): ColumnMapping {
  const mapping = Object.fromEntries(TARGET_FIELDS.map((f) => [f, null])) as ColumnMapping;
  const normalized = headers.map(normalizeHeader);
  for (const [field, re] of HEADER_PATTERNS) {
    const idx = normalized.findIndex((h, i) => re.test(h) && !Object.values(mapping).includes(i));
    if (idx !== -1) mapping[field] = idx;
  }
  return mapping;
}

// ── Normalizări de valori ───────────────────────────────────────────────────

/**
 * dd.mm.yyyy / dd/mm/yyyy / dd-mm-yyyy (an și pe 2 cifre), yyyy-mm-dd (și ISO
 * complet) sau serial Excel (zile de la 30.12.1899). Întoarce null când nu e dată.
 */
export function parseImportDate(raw: string): Date | null {
  const v = raw.trim();
  if (!v) return null;

  let m = v.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})(?:\s.*)?$/);
  if (m) {
    const d = Number(m[1]), mo = Number(m[2]);
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return validDate(y, mo, d);
  }
  m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]));

  if (/^\d{4,6}(\.\d+)?$/.test(v)) {
    const serial = Number(v);
    // 1990 … 2100, ca să nu luăm un cod numeric drept dată.
    if (serial >= 32874 && serial <= 73415) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000);
      return Number.isNaN(d.getTime()) ? null : d;
    }
  }
  return null;
}

function validDate(y: number, mo: number, d: number): Date | null {
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null;
}

/** Cheie de comparare pentru telefoane: doar cifre, prefixul de țară RO redus la „0”. */
export function phoneKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("0040")) digits = "0" + digits.slice(4);
  else if (digits.startsWith("40") && digits.length === 11) digits = "0" + digits.slice(2);
  else if (digits.length === 9 && digits.startsWith("7")) digits = "0" + digits;
  return digits.length >= 6 ? digits : null;
}

const emailSchema = z.string().email();
function cleanEmail(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  return v && emailSchema.safeParse(v).success ? v : null;
}

/** „Popescu Ion Marian” → { firstName: "Popescu Ion", lastName: "Marian" } (ultimul token = nume de familie). */
export function splitPersonName(name: string): { firstName: string | null; lastName: string } {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) return { firstName: null, lastName: tokens[0] ?? "" };
  return { firstName: tokens.slice(0, -1).join(" "), lastName: tokens[tokens.length - 1] };
}

// ── Geografie (cache pe durata unui import) ─────────────────────────────────

type GeoState = { id: number; name: string; norm: string };
type GeoCity = { id: number; name: string; stateId: number; norm: string };

/**
 * Potrivire județ/localitate pe tabelele noastre, cu aceleași normalizări ca la
 * ANAF (`normalizePlace`), dar cu listele încărcate o singură dată — un import
 * de 2 000 de rânduri nu poate face 2 interogări pe rând.
 */
class GeoMatcher {
  private countryId: number | null = null;
  private states: GeoState[] = [];
  private cities: GeoCity[] | null = null;
  private loaded = false;

  constructor(private readonly prisma: Prisma.TransactionClient | FastifyInstance["prisma"]) {}

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    const ro = await this.prisma.country.findFirst({ where: { iso2: "RO" }, select: { id: true } });
    if (!ro) return;
    this.countryId = ro.id;
    const states = await this.prisma.state.findMany({ where: { countryId: ro.id }, select: { id: true, name: true } });
    this.states = states.map((s) => ({ ...s, norm: normalizePlace(s.name) }));
  }

  private async loadCities() {
    if (this.cities || !this.countryId) return;
    const cities = await this.prisma.city.findMany({
      where: { countryId: this.countryId },
      select: { id: true, name: true, stateId: true },
    });
    this.cities = cities.map((c) => ({ ...c, norm: normalizePlace(c.name) }));
  }

  async match(county: string, city: string): Promise<{ countryId: number | null; stateId: number | null; cityId: number | null }> {
    await this.load();
    const result = { countryId: this.countryId, stateId: null as number | null, cityId: null as number | null };
    if (!this.countryId) return result;

    const judet = normalizePlace(county);
    const loc = normalizePlace(city);
    // „Sector 3” sau „București” fără județ ⇒ județul e București.
    const bucharest = this.states.find((s) => s.norm === "bucuresti");
    let state: GeoState | undefined;
    if (judet) {
      state = this.states.find((s) => s.norm === judet) ?? this.states.find((s) => s.norm.startsWith(judet));
    } else if (bucharest && (/^sector \d$/.test(loc) || loc === "bucuresti")) {
      state = bucharest;
    }
    if (state) result.stateId = state.id;

    if (!loc) return result;
    await this.loadCities();
    const pool = (this.cities ?? []).filter((c) => !state || c.stateId === state.id);
    let found = pool.filter((c) => c.norm === loc);
    if (found.length === 0 && state) {
      // Reședința de județ scrisă aproximativ, sau „Bucuresti” fără sector.
      found = pool.filter((c) => c.norm === judet && loc.includes(judet));
      if (found.length === 0) found = pool.filter((c) => loc.startsWith(c.norm) || c.norm.startsWith(loc));
    }
    // Fără județ, acceptăm doar o potrivire fără echivoc.
    if (found.length === 1 || (found.length > 1 && state)) {
      result.cityId = found[0].id;
      if (!result.stateId) result.stateId = found[0].stateId;
    }
    return result;
  }
}

// ── Import ──────────────────────────────────────────────────────────────────

export interface ImportRowError {
  /** Numărul rândului din fișier (antetul e rândul 1). */
  row: number;
  message: string;
}

export interface ImportResult {
  created: number;
  skipped: number;
  errors: ImportRowError[];
}

type PreparedRow = {
  row: number;
  type: "COMPANY" | "PERSON";
  companyName: string | null;
  cui: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  address: string | null;
  geo: { countryId: number | null; stateId: number | null; cityId: number | null };
  pod: string | null;
  codClient: string | null;
  lastRevisionDate: Date | null;
  lastInstalatieDate: Date | null;
};

export async function importClients(
  fastify: FastifyInstance,
  tenantId: string,
  sheet: ParsedSheet,
  mapping: Partial<ColumnMapping>,
  skipDuplicates: boolean,
): Promise<ImportResult> {
  const prisma = fastify.prisma;
  const col = (field: TargetField) => {
    const idx = mapping[field];
    return typeof idx === "number" && idx < sheet.headers.length ? idx : null;
  };
  if (col("name") === null) throw fastify.httpErrors.badRequest("Coloana „Nume client” este obligatorie în mapare");

  const result: ImportResult = { created: 0, skipped: 0, errors: [] };
  const addError = (row: number, message: string) => {
    if (result.errors.length < MAX_ERRORS) result.errors.push({ row, message });
  };

  // Dubluri: telefoane/e-mailuri deja în firmă + cele din fișierul curent.
  const existing = await prisma.client.findMany({ where: { tenantId }, select: { phone: true, email: true } });
  const seenPhones = new Set(existing.map((c) => phoneKey(c.phone)).filter((k): k is string => !!k));
  const seenEmails = new Set(existing.map((c) => c.email?.trim().toLowerCase()).filter((k): k is string => !!k));

  const geo = new GeoMatcher(prisma);
  const get = (cells: string[], field: TargetField) => {
    const idx = col(field);
    return idx === null ? "" : (cells[idx] ?? "").trim();
  };

  // 1. Validare + normalizare per rând (în afara tranzacțiilor).
  const prepared: PreparedRow[] = [];
  for (let i = 0; i < sheet.rows.length; i++) {
    const cells = sheet.rows[i];
    const rowNo = i + 2;
    const name = get(cells, "name").replace(/\s+/g, " ");
    if (!name) {
      addError(rowNo, "Lipsește numele clientului");
      result.skipped++;
      continue;
    }

    const phone = get(cells, "phone") || null;
    const email = cleanEmail(get(cells, "email"));
    const pKey = phoneKey(phone);
    if (skipDuplicates && ((pKey && seenPhones.has(pKey)) || (email && seenEmails.has(email)))) {
      result.skipped++;
      continue;
    }
    if (pKey) seenPhones.add(pKey);
    if (email) seenEmails.add(email);

    const revRaw = get(cells, "lastRevisionDate");
    const lastRevisionDate = parseImportDate(revRaw);
    if (revRaw && !lastRevisionDate) addError(rowNo, `Data reviziei „${revRaw}” nu a fost recunoscută — clientul s-a importat fără revizie`);
    const instRaw = get(cells, "lastInstalatieDate");
    const lastInstalatieDate = parseImportDate(instRaw);
    if (instRaw && !lastInstalatieDate) addError(rowNo, `Data verificării „${instRaw}” nu a fost recunoscută — s-a ignorat`);

    const cui = get(cells, "cui").replace(/^RO/i, "").trim() || null;
    const county = get(cells, "county");
    const city = get(cells, "city");
    const addressText = get(cells, "address");
    const address = addressText || [city, county].filter(Boolean).join(", ") || null;
    const person = cui ? null : splitPersonName(name);

    prepared.push({
      row: rowNo,
      type: cui ? "COMPANY" : "PERSON",
      companyName: cui ? name : null,
      cui,
      firstName: person?.firstName ?? null,
      lastName: person?.lastName ?? null,
      phone,
      email,
      notes: get(cells, "notes") || null,
      address,
      geo: address ? await geo.match(county, city) : { countryId: null, stateId: null, cityId: null },
      pod: get(cells, "pod") || null,
      codClient: get(cells, "codClient") || null,
      lastRevisionDate,
      lastInstalatieDate,
    });
  }

  // 2. Scriere în loturi; un lot care pică se reia rând cu rând ca să izolăm rândul vinovat.
  for (let start = 0; start < prepared.length; start += BATCH_SIZE) {
    const batch = prepared.slice(start, start + BATCH_SIZE);
    try {
      await prisma.$transaction(
        async (tx) => {
          for (const r of batch) await createOne(tx, tenantId, r);
        },
        { maxWait: 5_000, timeout: 60_000 },
      );
      result.created += batch.length;
    } catch {
      for (const r of batch) {
        try {
          await prisma.$transaction((tx) => createOne(tx, tenantId, r));
          result.created++;
        } catch (err) {
          result.skipped++;
          addError(r.row, err instanceof Error ? err.message.split("\n")[0].slice(0, 200) : "Eroare la salvare");
        }
      }
    }
  }

  return result;
}

async function createOne(tx: Prisma.TransactionClient, tenantId: string, r: PreparedRow): Promise<void> {
  const client = await tx.client.create({
    data: {
      tenantId,
      type: r.type,
      // Vin din evidența firmei, deci sunt clienți existenți, nu prospecți.
      status: "ACTIVE",
      companyName: r.companyName,
      cui: r.cui,
      firstName: r.firstName,
      lastName: r.lastName,
      phone: r.phone,
      email: r.email,
      notes: r.notes,
      ...(r.address && {
        addresses: {
          create: {
            address: r.address,
            countryId: r.geo.countryId,
            stateId: r.geo.stateId,
            cityId: r.geo.cityId,
            isPrimary: true,
          },
        },
      }),
    },
    select: { id: true, addresses: { select: { id: true }, take: 1 } },
  });
  const addressId = client.addresses[0]?.id ?? null;

  if (r.pod || r.codClient || r.lastInstalatieDate) {
    await tx.gasInstallation.create({
      data: {
        clientId: client.id,
        clientAddressId: addressId,
        codTehnicPOD: r.pod,
        codClient: r.codClient,
        lastVerificationDate: r.lastInstalatieDate,
      },
    });
  }

  if (r.lastRevisionDate) {
    // Aceeași formă ca `equipment-revisions.service.create` (COMPLETED, fără PDF):
    // panoul calculează scadența din ultima revizie per centrală.
    await tx.equipment.create({
      data: {
        clientId: client.id,
        clientAddressId: addressId,
        type: "CENTRALA",
        name: "Centrală (import)",
        internalName: "Centrală (import)",
        revisions: {
          create: {
            revisionDate: r.lastRevisionDate,
            status: "COMPLETED",
            notes: "Revizie preluată din evidența anterioară (import)",
          },
        },
      },
    });
  }
}
