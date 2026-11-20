import type { FastifyInstance } from "fastify";
import ExcelJS from "exceljs";
import type { ApptScope } from "../appointments/scope.js";
import type { ListRevisionsQuery } from "./revisions.schema.js";
import { list, type OsState } from "./revisions.service.js";

const TYPE_LABEL: Record<string, string> = {
  revizie: "Revizie centrală",
  revizie_instalatie: "Revizie instalație",
  verificare_instalatie: "Verificare instalație",
};
const OS_LABEL: Record<OsState, string> = {
  overdue: "Termen depășit",
  to_submit: "De depus",
  submitted: "Depus, așteaptă număr",
  registered: "Înregistrat",
  none: "—",
};
const fmt = (d: Date | null | undefined) => (d ? d.toLocaleDateString("ro-RO") : "");

/** Lista din pagina Revizii, cu aceleași filtre și în aceeași ordine, fără paginare. */
export async function exportRevisionsXlsx(fastify: FastifyInstance, tenantId: string, q: ListRevisionsQuery, scope?: ApptScope): Promise<Buffer> {
  const { data } = await list(fastify, tenantId, { ...q, page: 1, limit: 100_000 }, scope);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Operio";
  wb.created = new Date();
  const ws = wb.addWorksheet("Revizii", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "Data", key: "data", width: 12 },
    { header: "Tip", key: "tip", width: 22 },
    { header: "Beneficiar", key: "client", width: 30 },
    { header: "Adresa", key: "adresa", width: 40 },
    { header: "Centrală / instalație", key: "subiect", width: 26 },
    { header: "Distribuitor", key: "osd", width: 24 },
    { header: "Tehnician", key: "tehnician", width: 22 },
    { header: "Decizie", key: "decizie", width: 10 },
    { header: "Înregistrare OS", key: "os", width: 22 },
    { header: "Termen depunere", key: "termen", width: 14 },
    { header: "Depus la", key: "depus", width: 12 },
    { header: "Nr. OS", key: "nrOs", width: 16 },
    { header: "Înregistrat la", key: "inreg", width: 14 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } };
  for (const r of data) {
    ws.addRow({
      data: fmt(r.date),
      tip: TYPE_LABEL[r.type] ?? r.type,
      client: r.client?.name ?? "",
      adresa: r.address ?? "",
      subiect: r.subject ?? "",
      osd: r.distributorName ?? "",
      tehnician: r.employee?.name ?? "",
      decizie: r.decision === "admis" ? "Admis" : r.decision === "respins" ? "Respins" : "",
      os: OS_LABEL[r.osState ?? "none"],
      termen: fmt(r.osDeadline),
      depus: fmt(r.appointment?.osSubmittedAt),
      nrOs: r.appointment?.osRegistrationNumber ?? "",
      inreg: fmt(r.appointment?.osRegisteredAt),
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
