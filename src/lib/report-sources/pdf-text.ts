import { execFile } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Text cu layout din PDF (pdftotext -layout). Parserii pe regex se bazează pe
 * coloanele păstrate de `-layout`, deci toate sursele primesc același text.
 */
export function extractPdfText(buffer: Buffer): Promise<string> {
  const tmpPath = join(tmpdir(), `report-${randomUUID()}.pdf`);
  return new Promise<string>((resolve, reject) => {
    writeFile(tmpPath, buffer)
      .then(() => {
        execFile(
          "pdftotext",
          ["-layout", tmpPath, "-"],
          { timeout: 30000, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
          (err, stdout) => {
            unlink(tmpPath).catch(() => {});
            if (err) reject(new Error(`pdftotext failed: ${err.message}`));
            else resolve(stdout);
          },
        );
      })
      .catch((err) => {
        unlink(tmpPath).catch(() => {});
        reject(err);
      });
  });
}

/** Tipurile de fișier pe care le primesc toate punctele de intrare ale rapoartelor. */
export type ReportFileKind = "pdf" | "xml" | "csv" | "txt";

const EXT_KINDS: Record<string, ReportFileKind> = {
  ".pdf": "pdf",
  ".xml": "xml",
  ".csv": "csv",
  ".txt": "txt",
};

const MIME_KINDS: Record<string, ReportFileKind> = {
  "application/pdf": "pdf",
  "application/xml": "xml",
  "text/xml": "xml",
  "text/csv": "csv",
  "text/comma-separated-values": "csv",
  "application/vnd.ms-excel": "csv",
  "text/plain": "txt",
};

/** Mimetype-urile acceptate (pentru validări și mesaje). */
export const REPORT_FILE_MIMETYPES = Object.keys(MIME_KINDS);

/** Mimetype-ul canonic pentru un fel de fișier (S3 păstrează originalul când îl are). */
export const REPORT_FILE_CANONICAL_MIME: Record<ReportFileKind, string> = {
  pdf: "application/pdf",
  xml: "application/xml",
  csv: "text/csv",
  txt: "text/plain",
};

/**
 * Felul fișierului după extensie (prioritar — clienții trimit des
 * `application/octet-stream` sau `application/vnd.ms-excel` pentru CSV), apoi
 * după mimetype; null dacă nu e un fișier de raport acceptat.
 */
export function reportFileKind(filename: string | undefined | null, mimetype?: string | null): ReportFileKind | null {
  const ext = extname(filename ?? "").toLowerCase();
  if (ext && EXT_KINDS[ext]) return EXT_KINDS[ext];
  const mime = (mimetype ?? "").split(";")[0].trim().toLowerCase();
  if (mime && MIME_KINDS[mime]) {
    // `application/vnd.ms-excel` cu .xls/.xlsx real nu e CSV.
    if (mime === "application/vnd.ms-excel" && ext && ext !== ".csv") return null;
    return MIME_KINDS[mime];
  }
  return null;
}

export const ACCEPTED_REPORT_FILES_MESSAGE = "Doar fișiere PDF, XML, CSV sau TXT sunt acceptate";

/** Text din buffer: UTF-8 (fără BOM), cu rezervă latin1 când UTF-8 e corupt. */
function bufferToText(buffer: Buffer): string {
  let text = buffer.toString("utf8");
  if (text.includes("�")) text = buffer.toString("latin1");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // UTF-16 cu BOM (unele exporturi Windows).
  if (buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))) {
    const le = buffer[0] === 0xff;
    const body = le ? buffer.subarray(2) : Buffer.from(buffer.subarray(2)).swap16();
    text = body.toString("utf16le");
  }
  return text;
}

/**
 * Textul unui fișier de raport, indiferent de tip: pdftotext pentru PDF,
 * decodare UTF-8/latin1 pentru XML/CSV/TXT. Pentru un tip necunoscut încearcă
 * PDF-ul după semnătură (`%PDF`), altfel decodează ca text.
 */
export async function extractText(buffer: Buffer, filename?: string | null, mimetype?: string | null): Promise<string> {
  const kind = reportFileKind(filename, mimetype);
  if (kind === "pdf") return extractPdfText(buffer);
  if (kind) return bufferToText(buffer);
  if (buffer.subarray(0, 5).toString("latin1").startsWith("%PDF")) return extractPdfText(buffer);
  return bufferToText(buffer);
}
