import ExcelJS from "exceljs";
import type { TargetField } from "./clients-import.js";

/**
 * Modelul pentru importul de clienți: coloanele pe care importul le recunoaște
 * singur (vezi `suggestMapping`), două rânduri de exemplu inventate și, în Excel,
 * o foaie cu explicații. Ordinea coloanelor = `TARGET_FIELDS`.
 */
const COLUMNS: { field: TargetField; header: string; width: number; note: string }[] = [
  { field: "name", header: "Nume", width: 28, note: "Obligatoriu. Persoană („Popescu Ion”) sau firmă („Exemplu SRL”)." },
  { field: "phone", header: "Telefon", width: 16, note: "Folosit la programări și la găsirea duplicatelor." },
  { field: "email", header: "E-mail", width: 28, note: "Opțional; și el ajută la găsirea duplicatelor." },
  { field: "cui", header: "CUI", width: 14, note: "Doar pentru firme." },
  { field: "address", header: "Adresă", width: 34, note: "Strada, numărul, blocul, apartamentul." },
  { field: "city", header: "Localitate", width: 16, note: "" },
  { field: "county", header: "Județ", width: 14, note: "" },
  { field: "pod", header: "Cod tehnic (POD)", width: 20, note: "Codul locului de consum de la distribuitor." },
  { field: "codClient", header: "Cod client", width: 14, note: "Codul clientului la distribuitor." },
  { field: "lastRevisionDate", header: "Ultima revizie centrală", width: 22, note: "Data (zz.ll.aaaa). Din ea se calculează scadența la 2 ani." },
  { field: "lastInstalatieDate", header: "Ultima revizie/verificare instalație", width: 32, note: "Data (zz.ll.aaaa). Scadența: 2 ani verificarea, 10 ani revizia." },
  { field: "notes", header: "Observații", width: 30, note: "Orice altceva despre client." },
];

const EXAMPLES: Record<TargetField, string>[] = [
  {
    name: "Popescu Ion", phone: "0722 123 456", email: "ion.popescu@exemplu.ro", cui: "", address: "Str. Florilor nr. 12, bl. A2, ap. 5",
    city: "Ploiești", county: "Prahova", pod: "DEGPHPLO0123456", codClient: "5400123", lastRevisionDate: "15.03.2025", lastInstalatieDate: "10.09.2024", notes: "Sună înainte cu o zi",
  },
  {
    name: "Exemplu Construct SRL", phone: "0244 555 111", email: "office@exemplu-construct.ro", cui: "RO12345678", address: "Bd. Independenței nr. 4",
    city: "Câmpina", county: "Prahova", pod: "", codClient: "", lastRevisionDate: "02.11.2024", lastInstalatieDate: "", notes: "",
  },
];

export async function importTemplateXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Clienți");
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.field, width: c.width }));
  for (const row of EXAMPLES) ws.addRow(row);
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4E04D" } };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  // Datele ca text („15.03.2025”), ca Excel să nu le schimbe formatul.
  for (const key of ["lastRevisionDate", "lastInstalatieDate", "phone", "pod", "codClient"]) ws.getColumn(key).numFmt = "@";

  const help = wb.addWorksheet("Explicații");
  help.columns = [{ header: "Coloana", width: 36 }, { header: "Ce scrii", width: 80 }];
  help.getRow(1).font = { bold: true };
  for (const c of COLUMNS) help.addRow([c.header, c.note]);
  help.addRow([]);
  help.addRow(["", "Șterge cele două rânduri de exemplu și pune clienții tăi, câte unul pe rând. Prima linie (numele coloanelor) rămâne."]);
  help.addRow(["", "Coloanele pot fi în altă ordine sau pot lipsi (doar Nume e obligatoriu); la import le potrivești."]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** CSV cu „;” și BOM — se deschide corect în Excel-ul românesc. */
export function importTemplateCsv(): Buffer {
  const cell = (v: string) => (/[";\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [COLUMNS.map((c) => c.header), ...EXAMPLES.map((r) => COLUMNS.map((c) => r[c.field]))].map((r) => r.map(cell).join(";"));
  return Buffer.from("﻿" + lines.join("\r\n") + "\r\n", "utf8");
}
