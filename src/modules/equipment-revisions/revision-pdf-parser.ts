import { execFileSync } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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
  analysisData: Record<string, unknown>;
  rawText: string;
}

function extractField(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  return match?.[1]?.trim() || null;
}

function parseDate(dateStr: string): Date | null {
  // Format: DD/MM/YY
  const match = dateStr.match(/(\d{2})\/(\d{2})\/(\d{2})/);
  if (!match) return null;
  const [, day, month, yearShort] = match;
  const year = parseInt(yearShort) < 50 ? 2000 + parseInt(yearShort) : 1900 + parseInt(yearShort);
  return new Date(year, parseInt(month) - 1, parseInt(day));
}

async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  const tmpPath = join(tmpdir(), `revision-${randomUUID()}.pdf`);
  try {
    await writeFile(tmpPath, buffer);
    const stdout = execFileSync("pdftotext", ["-layout", tmpPath, "-"], {
      timeout: 30000,
      encoding: "utf-8",
    });
    return stdout;
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

export function parseRevisionText(rawText: string): ParsedRevision {
  // The PDF has a column layout with lots of whitespace.
  // Labels and values are on the same line, separated by multiple spaces.

  // --- Info section (first block before "Analyses:") ---
  const location = extractField(rawText, /Location:\s*(.+?)(?:\s{2,}|$)/);
  const clientName = extractField(rawText, /Client:\s*(.+?)(?:\s{2,}|$)/);
  const clientSurname = extractField(rawText, /Surname:\s*(.+?)(?:\s{2,}|$)/);
  const clientAddress = extractField(rawText, /Client address:\s*(.+?)(?:\s{2,}|$)/);
  const clientPhone = extractField(rawText, /Client phone:\s*(.+?)(?:\s{2,}|$)/);
  const clientEmail = extractField(rawText, /Client email:\s*(.+?)(?:\s{2,}|$)/);

  // Equipment (on same line as Location/Client, in second column)
  const equipmentName = extractField(rawText, /Equipment:\s*(.+?)(?:\s{2,}|$)/);
  const equipmentSerial = extractField(rawText, /Address:\s*(EUROSTAR\s+\S+)/);

  // Operator (third column in info section)
  const operatorName = extractField(rawText, /Operator:\s*(.+?)$/m);
  // Operator address is in the third column (rightmost).
  // On the line with "Client:", there are two "Address:" entries — the one after position 60 is the operator's.
  const operatorAddressLines: string[] = [];
  const lines = rawText.split("\n");
  let foundOperator = false;
  let collectOperatorAddr = false;
  for (const line of lines) {
    if (line.includes("Operator:")) {
      foundOperator = true;
      continue;
    }
    if (foundOperator && !collectOperatorAddr) {
      // Look for "Address:" in the right portion of the line (after col 60)
      const rightPart = line.length > 60 ? line.substring(60) : "";
      const addrMatch = rightPart.match(/Address:\s*(.+)/);
      if (addrMatch) {
        const addr = addrMatch[1].trim().replace(/,\s*$/, "");
        if (addr) operatorAddressLines.push(addr);
        collectOperatorAddr = true;
        continue;
      }
    }
    if (collectOperatorAddr) {
      const rightPart = line.length > 60 ? line.substring(60).trim() : "";
      if (rightPart.startsWith("Phone:") || rightPart.startsWith("E-mail:")) {
        collectOperatorAddr = false;
      } else {
        // Continuation line — could be in right column or just a short line
        const continuation = rightPart || line.trim();
        if (continuation && operatorAddressLines.length < 3) {
          operatorAddressLines.push(continuation);
        }
        if (!rightPart && !line.trim()) collectOperatorAddr = false;
      }
    }
  }
  const operatorAddress = operatorAddressLines.length > 0 ? operatorAddressLines.join(", ") : null;
  const operatorPhone = extractField(rawText, /Phone:\s*(\d[\d\s]+)/);
  const operatorEmail = extractField(rawText, /E-mail:\s*(\S+@\S+)/);

  // --- Analyses section ---
  const analyzerName = extractField(rawText, /Chemist\s+(.+)/);
  // Serial number is on same line, separated by whitespace
  const analyzerSerial = extractField(rawText, /Numar Serial\s+([\d]+)/);

  // Revision date — same-line format with whitespace
  const dateStr = extractField(rawText, /Data\s+([\d/]+)/);
  const revisionDate = dateStr ? parseDate(dateStr) : null;

  // Analysis metadata
  const analysisData: Record<string, unknown> = {};

  const combustibil = extractField(rawText, /Combustibil\s+(.+)/);
  if (combustibil) analysisData.combustibil = combustibil.trim();

  const altitudine = extractField(rawText, /Altitudine\s+(.+)/);
  if (altitudine) analysisData.altitudine = altitudine.trim();

  const umiditate = extractField(rawText, /URAer\s+(.+)/);
  if (umiditate) analysisData.umiditate = umiditate.trim();

  const ora = extractField(rawText, /Ora\s+(\d{2}:\d{2})/);
  if (ora) analysisData.ora = ora;

  // Analysis readings — label followed by whitespace then value, all on same line
  const readings: Record<string, string> = {};
  const analysisPatterns: [string, RegExp][] = [
    ["tGaz", /T gaz\s+([\d.]+\s*°C)/],
    ["tAer", /T aer\s+([\d.]+\s*°C)/],
    ["o2", /O2\s+([\d.]+\s*%)/],
    ["co2", /CO2\s+([\d.]+\s*%)/],
    ["co", /^.*(?<![(\w])CO\s+(\d+\s*ppm)/m],
    ["coCorr", /CO\([\d.]+%\)\s+(\d+\s*ppm)/],
    ["ec", /Ec\s+([\d.]+\s*%)/],
    ["lambda", /l;n\s+([\d.]+)/],
    ["excessAir", /ExcesAer\s+(\d+\s*%)/],
    ["dT", /dT\s+([\d.]+\s*°C)/],
    ["qs", /Qs\s+([\d.]+\s*%)/],
    ["es", /Es\s+([\d.]+\s*%)/],
    ["et", /Et\s+([\d.]+\s*%)/],
    ["no", /^.*(?<![N])NO\s+(\d+\s*ppm)/m],
    ["nox", /NOx\s+(\d+\s*ppm)/],
    ["noCorr", /NO\([\d.]+%\)\s+(\d+\s*ppm)/],
    ["noxCorr", /NOx\([\d.]+%\)\s+(\d+\s*ppm)/],
    ["pi", /PI\s+([\d.]+\s*%)/],
  ];

  for (const [key, pattern] of analysisPatterns) {
    const value = extractField(rawText, pattern);
    if (value) readings[key] = value;
  }

  if (Object.keys(readings).length > 0) {
    analysisData.readings = readings;
  }

  return {
    revisionDate,
    location,
    clientName,
    clientSurname,
    clientAddress: clientAddress ?? null,
    clientPhone: clientPhone === "---" ? null : clientPhone,
    clientEmail: clientEmail === "---" ? null : clientEmail,
    equipmentName,
    equipmentSerial,
    operator: {
      name: operatorName,
      address: operatorAddress,
      phone: operatorPhone,
      email: operatorEmail,
    },
    analyzer: {
      name: analyzerName,
      serial: analyzerSerial,
    },
    analysisData,
    rawText,
  };
}

export async function parseRevisionPdf(buffer: Buffer): Promise<ParsedRevision> {
  const rawText = await extractTextFromPdf(buffer);
  return parseRevisionText(rawText);
}
