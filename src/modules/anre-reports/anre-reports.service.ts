import type { FastifyInstance } from "fastify";
import ExcelJS from "exceljs";
import { INSTALATIE_APPT_TYPES, clientDisplayName } from "../appointments/os-registration.js";

/**
 * Registrul anual de evidență a verificărilor și reviziilor tehnice (Anexa nr. 6 la
 * Procedura aprobată prin Ord. ANRE 179/2015, art. 12) și centralizatorul
 * formularelor de apreciere a clientului (cunoscut în branșă ca „Anexa 14”),
 * ambele ca foi într-un singur fișier Excel. Datele vin din rapoartele de
 * revizie/verificare instalație finalizate în anul cerut; numărul fișei este
 * numărul din registratură al PDF-ului RT/FISA generat.
 */

const FISA_CATEGORY_CODES = ["REVIZIE_INSTALATIE_RT", "VERIFICARE_INSTALATIE_FISA"];

const APRECIERE_QUESTIONS = [
  "Durata lucrărilor/serviciilor în raport cu prevederile contractuale",
  "Numărul și pregătirea personalului alocat",
  "Disponibilitatea și calitatea dotărilor, materialelor și documentelor elaborate",
  "Modul de rezolvare a solicitărilor punctuale",
  "Aprecierea generală a lucrărilor/serviciilor",
];

type FisaRef = { nr: string; data: string };

const fmt = (d: Date | null | undefined) => (d ? d.toLocaleDateString("ro-RO") : "");

export async function buildAnexa6Workbook(fastify: FastifyInstance, tenantId: string, year: number) {
  const from = new Date(year, 0, 1);
  const to = new Date(year + 1, 0, 1);

  const [tenant, appts] = await Promise.all([
    fastify.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, cui: true } }),
    fastify.prisma.appointment.findMany({
      where: {
        tenantId,
        deletedAt: null,
        status: "completed",
        type: { in: [...INSTALATIE_APPT_TYPES] },
        // Anul în care s-a întocmit fișa = data vizitei; completedAt e doar rezerva
        // pentru vizitele vechi fără dată de finalizare.
        date: { gte: from, lt: to },
      },
      include: {
        client: { select: { companyName: true, firstName: true, lastName: true } },
        clientAddress: { select: { address: true } },
        installation: { select: { codTehnicPOD: true, codClient: true, contractNumber: true, contractDate: true, distributorName: true } },
      },
      orderBy: { date: "asc" },
    }),
  ]);

  // Numerele fișelor: PDF-ul RT/FISA al fiecărei programări → intrarea lui din registratură.
  const ids = appts.map((a) => a.id);
  const docs = ids.length
    ? await fastify.prisma.document.findMany({
        where: {
          tenantId,
          template: { categoryCode: { in: FISA_CATEGORY_CODES } },
          createdAt: { gte: from },
        },
        select: {
          contextJson: true,
          createdAt: true,
          registryEntries: { select: { displayNumber: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 1 },
        },
      })
    : [];
  const fisaByAppt = new Map<string, FisaRef>();
  for (const d of docs) {
    const apptId = (d.contextJson as { appointmentId?: string } | null)?.appointmentId;
    if (!apptId || fisaByAppt.has(apptId)) continue;
    const entry = d.registryEntries[0];
    if (entry) fisaByAppt.set(apptId, { nr: entry.displayNumber, data: fmt(entry.createdAt) });
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "Operio";
  wb.created = new Date();

  // ── Foaia 1: Anexa 6 ──────────────────────────────────────────────────────
  const ws = wb.addWorksheet("Anexa 6", { views: [{ state: "frozen", ySplit: 6 }] });
  ws.columns = [
    { key: "nr", width: 6 }, { key: "client", width: 32 }, { key: "adresa", width: 40 }, { key: "cod", width: 22 },
    { key: "ctrNr", width: 14 }, { key: "ctrData", width: 12 }, { key: "indiv", width: 11 }, { key: "comuna", width: 10 },
    { key: "verNr", width: 14 }, { key: "verData", width: 12 }, { key: "revNr", width: 14 }, { key: "revData", width: 12 },
    { key: "da", width: 7 }, { key: "nu", width: 7 }, { key: "os", width: 18 },
  ];
  ws.mergeCells("A1:O1");
  ws.getCell("A1").value =
    `ANEXA nr. 6 — REGISTRU DE EVIDENȚĂ privind verificările și reviziile tehnice ale instalațiilor de utilizare a gazelor naturale efectuate în cursul anului ${year}`;
  ws.getCell("A1").font = { bold: true, size: 12 };
  ws.mergeCells("A2:O2");
  ws.getCell("A2").value = `Operator economic autorizat ANRE: ${tenant?.name ?? ""}${tenant?.cui ? ` (CUI ${tenant.cui})` : ""}`;
  ws.mergeCells("A3:O3");
  ws.getCell("A3").value = "Întocmit conform Ord. ANRE nr. 179/2015, art. 12 alin. (2). Coloana „Nr. înreg. OS” este internă (nu face parte din anexă).";
  ws.getCell("A3").font = { italic: true, size: 9, color: { argb: "FF666666" } };

  // Antet pe două rânduri, cu îmbinări — exact grupurile din anexă.
  const h1 = 5, h2 = 6;
  const head = (range: string, text: string) => {
    ws.mergeCells(range);
    const c = ws.getCell(range.split(":")[0]);
    c.value = text;
  };
  head(`A${h1}:A${h2}`, "Nr. crt.");
  head(`B${h1}:B${h2}`, "Numele și prenumele clientului final");
  head(`C${h1}:C${h2}`, "Adresa locului de consum");
  head(`D${h1}:D${h2}`, "Codul locului de consum");
  head(`E${h1}:F${h1}`, "Contractul de prestări servicii¹⁾");
  ws.getCell(`E${h2}`).value = "Nr."; ws.getCell(`F${h2}`).value = "Data";
  head(`G${h1}:H${h1}`, "Instalația de utilizare a gazelor naturale");
  ws.getCell(`G${h2}`).value = "Individuală"; ws.getCell(`H${h2}`).value = "Comună";
  head(`I${h1}:J${h1}`, "Fișa de evidență a lucrărilor periodice de verificare tehnică");
  ws.getCell(`I${h2}`).value = "Nr."; ws.getCell(`J${h2}`).value = "Data";
  head(`K${h1}:L${h1}`, "Fișa de evidență a lucrărilor periodice de revizie tehnică");
  ws.getCell(`K${h2}`).value = "Nr."; ws.getCell(`L${h2}`).value = "Data";
  head(`M${h1}:N${h1}`, "Instalația respectă prevederile normelor tehnice și poate funcționa în condiții de siguranță");
  ws.getCell(`M${h2}`).value = "Da"; ws.getCell(`N${h2}`).value = "Nu";
  head(`O${h1}:O${h2}`, "Nr. înreg. OS (intern)");
  for (const r of [h1, h2]) {
    ws.getRow(r).eachCell({ includeEmpty: true }, (c) => {
      c.font = { bold: true, size: 9 };
      c.alignment = { wrapText: true, vertical: "middle", horizontal: "center" };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } };
      c.border = { top: { style: "thin" }, left: { style: "thin" }, bottom: { style: "thin" }, right: { style: "thin" } };
    });
  }
  ws.getRow(h1).height = 54;

  appts.forEach((a, i) => {
    const r = (a.completionDataJson ?? {}) as Record<string, unknown>;
    const fisa = fisaByAppt.get(a.id);
    const isRevizie = a.type === "revizie_instalatie";
    const comuna = r.tipLucrare === "comuna";
    const ok = r.conditiiTehniceOk;
    const row = ws.addRow({
      nr: i + 1,
      client: clientDisplayName(a.client),
      adresa: a.clientAddress?.address ?? "",
      cod: a.installation?.codTehnicPOD ?? "",
      ctrNr: a.installation?.contractNumber ?? "",
      ctrData: a.installation?.contractDate ?? "",
      indiv: comuna ? "" : "X",
      comuna: comuna ? "X" : "",
      verNr: !isRevizie ? fisa?.nr ?? "" : "",
      verData: !isRevizie ? fisa?.data ?? fmt(a.date) : "",
      revNr: isRevizie ? fisa?.nr ?? "" : "",
      revData: isRevizie ? fisa?.data ?? fmt(a.date) : "",
      da: ok === true ? "X" : "",
      nu: ok === false ? "X" : "",
      os: a.osRegistrationNumber ? `${a.osRegistrationNumber}${a.osRegisteredAt ? ` / ${fmt(a.osRegisteredAt)}` : ""}` : "",
    });
    row.eachCell({ includeEmpty: true }, (c) => {
      c.font = { size: 9 };
      c.alignment = { vertical: "top", wrapText: true };
      c.border = { top: { style: "thin" }, left: { style: "thin" }, bottom: { style: "thin" }, right: { style: "thin" } };
    });
  });
  const note = ws.addRow([]);
  ws.mergeCells(`A${note.number + 1}:O${note.number + 1}`);
  ws.getCell(`A${note.number + 1}`).value =
    "NOTĂ: ¹⁾ Se specifică toate contractele de prestări servicii aferente verificărilor și reviziilor tehnice ale instalațiilor de utilizare a gazelor naturale, inclusiv cele de remediere a defectelor constatate.";
  ws.getCell(`A${note.number + 1}`).font = { italic: true, size: 9 };

  // ── Foaia 2: Formulare de apreciere („Anexa 14”) ──────────────────────────
  const wa = wb.addWorksheet("Formulare de apreciere", { views: [{ state: "frozen", ySplit: 4 }] });
  wa.columns = [
    { key: "nr", width: 6 }, { key: "data", width: 12 }, { key: "client", width: 32 }, { key: "adresa", width: 40 },
    { key: "tip", width: 12 }, { key: "fisa", width: 14 },
    { key: "i1", width: 9 }, { key: "i2", width: 9 }, { key: "i3", width: 9 }, { key: "i4", width: 9 }, { key: "i5", width: 9 }, { key: "medie", width: 9 },
  ];
  wa.mergeCells("A1:L1");
  wa.getCell("A1").value = `FORMULARE DE APRECIERE privind calitatea lucrărilor/serviciilor — centralizator ${year}`;
  wa.getCell("A1").font = { bold: true, size: 12 };
  wa.mergeCells("A2:L2");
  wa.getCell("A2").value = `${tenant?.name ?? ""} · punctaj 1 (cel mai puțin mulțumit) … 10 (foarte mulțumit) · indicatori: ${APRECIERE_QUESTIONS.map((q, i) => `${i + 1}. ${q}`).join("; ")}`;
  wa.getCell("A2").font = { size: 9, color: { argb: "FF666666" } };
  wa.getCell("A2").alignment = { wrapText: true };
  wa.getRow(2).height = 42;
  const headRow = wa.getRow(4);
  headRow.values = ["Nr. crt.", "Data", "Client final", "Adresa locului de consum", "Lucrare", "Nr. fișă", "Ind. 1", "Ind. 2", "Ind. 3", "Ind. 4", "Ind. 5", "Media"];
  headRow.eachCell((c) => {
    c.font = { bold: true, size: 9 };
    c.alignment = { wrapText: true, vertical: "middle", horizontal: "center" };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } };
    c.border = { top: { style: "thin" }, left: { style: "thin" }, bottom: { style: "thin" }, right: { style: "thin" } };
  });

  let n = 0;
  const totals = [0, 0, 0, 0, 0];
  const counts = [0, 0, 0, 0, 0];
  for (const a of appts) {
    const r = (a.completionDataJson ?? {}) as Record<string, unknown>;
    const ap = (r.apreciere ?? null) as Record<string, number | undefined> | null;
    const scores = [1, 2, 3, 4, 5].map((k) => ap?.[`i${k}`]);
    if (!scores.some((s) => typeof s === "number")) continue;
    n += 1;
    const given = scores.filter((s): s is number => typeof s === "number");
    scores.forEach((s, i) => { if (typeof s === "number") { totals[i] += s; counts[i] += 1; } });
    const row = wa.addRow({
      nr: n,
      data: fmt(a.date),
      client: clientDisplayName(a.client),
      adresa: a.clientAddress?.address ?? "",
      tip: a.type === "revizie_instalatie" ? "Revizie" : "Verificare",
      fisa: fisaByAppt.get(a.id)?.nr ?? "",
      i1: scores[0] ?? "", i2: scores[1] ?? "", i3: scores[2] ?? "", i4: scores[3] ?? "", i5: scores[4] ?? "",
      medie: given.length ? Math.round((given.reduce((x, y) => x + y, 0) / given.length) * 10) / 10 : "",
    });
    row.eachCell({ includeEmpty: true }, (c) => {
      c.font = { size: 9 };
      c.border = { top: { style: "thin" }, left: { style: "thin" }, bottom: { style: "thin" }, right: { style: "thin" } };
    });
  }
  if (n > 0) {
    const avg = totals.map((t, i) => (counts[i] ? Math.round((t / counts[i]) * 10) / 10 : ""));
    const all = avg.filter((v): v is number => typeof v === "number");
    const row = wa.addRow({
      client: `Media pe indicator (${n} formulare)`,
      i1: avg[0], i2: avg[1], i3: avg[2], i4: avg[3], i5: avg[4],
      medie: all.length ? Math.round((all.reduce((x, y) => x + y, 0) / all.length) * 10) / 10 : "",
    });
    row.font = { bold: true, size: 9 };
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const safeName = (tenant?.name ?? "operio").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
  return { buffer, filename: `Anexa6-${year}-${safeName}.xlsx`, rows: appts.length, apreciere: n };
}
