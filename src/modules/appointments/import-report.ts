/**
 * Import din teren: tehnicianul încarcă PDF-ul analizorului direct pe
 * programare. Fișierul se salvează, se alege strategia firmei pentru tipul
 * programării, se detectează/alege sursa, se extrag datele, apoi:
 *   - `revizie`: revizia programării (EquipmentRevision) primește citirile +
 *     analizorul și e marcată COMPLETED; dacă raportul tehnicianului există deja,
 *     documentul ISCIR se regenerează;
 *   - revizie/verificare instalație: un rând Document (COMPLETED, cu PDF-ul)
 *     legat de client și de programare, ca să apară lângă documentele vizitei.
 * Răspunsul aduce și `prefill` — valorile pe care wizard-ul le poate completa.
 */
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import type { Queue } from "bullmq";
import { uploadFile } from "../../lib/s3.js";
import { safeS3Filename } from "../../lib/safe-filename.js";
import {
  detectSource,
  extractPdfText,
  getSource,
  ATTACH_ONLY_SOURCE_ID,
  type ParsedRevision,
  type ReportSource,
} from "../../lib/report-sources/index.js";
import {
  getReportSourcesSettings,
  getReportTypeConfig,
  AUTO_SOURCE,
} from "../tenant/report-sources-settings.js";
import {
  queueIscirIfReportExists,
  revisionDataFromParsed,
} from "../equipment-revisions/equipment-revisions.service.js";
import { matchOrCreateEquipment } from "../equipment-revisions/revision-matching.js";
import { type ApptScope, apptVisibilityWhere, canSeeEmployee } from "./scope.js";

export interface ReportPrefill {
  draftValue?: string;
  gasPressureRamp?: string;
  gasPressureBurner?: string;
  flueTemperature?: string;
  co?: string;
  o2?: string;
  efficiency?: string;
}

export interface ImportReportResult {
  strategy: string;
  sourceId: string;
  sourceLabel: string;
  score: number;
  revisionId?: string;
  documentId?: string;
  readings: Record<string, unknown>;
  prefill: ReportPrefill;
}

/** Partea numerică a unei citiri („52.7 °C" → „52.7"); undefined dacă nu e număr. */
function numericPart(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  const m = v.replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  return m ? m[0] : undefined;
}

/** Tirajul în mbar (câmpul wizard-ului): Pa → ÷100, hPa = mbar. */
function draftToMbar(v: unknown): string | undefined {
  const n = numericPart(v);
  if (n === undefined || typeof v !== "string") return n;
  if (/\bPa\b/.test(v) && !/hPa|mbar/i.test(v)) {
    const mbar = Number(n) / 100;
    return Number.isFinite(mbar) ? String(Number(mbar.toFixed(3))) : undefined;
  }
  return n;
}

/**
 * Cheile din `analysisData.readings` (convenția parserului Seitron) → câmpurile
 * wizard-ului de revizie (Sec. V, Verificări funcționale):
 *   draft → draftValue (mbar), gasPressureRamp → gasPressureRamp,
 *   gasPressureBurner → gasPressureBurner, tGaz → flueTemperature (°C),
 *   co → co (ppm), o2 → o2 (%), et (apoi es) → efficiency (%).
 * Valorile sunt doar partea numerică; absentele rămân undefined.
 */
export function prefillFromAnalysisData(analysisData: unknown): ReportPrefill {
  const data = analysisData && typeof analysisData === "object" ? (analysisData as Record<string, unknown>) : {};
  const r = data.readings && typeof data.readings === "object" ? (data.readings as Record<string, unknown>) : {};
  const prefill: ReportPrefill = {};
  const set = (k: keyof ReportPrefill, v: string | undefined) => {
    if (v !== undefined) prefill[k] = v;
  };
  set("draftValue", draftToMbar(r.draft));
  set("gasPressureRamp", numericPart(r.gasPressureRamp));
  set("gasPressureBurner", numericPart(r.gasPressureBurner));
  set("flueTemperature", numericPart(r.tGaz));
  set("co", numericPart(r.co));
  set("o2", numericPart(r.o2));
  set("efficiency", numericPart(r.et) ?? numericPart(r.es));
  return prefill;
}

const readingsOf = (parsed: ParsedRevision): Record<string, unknown> =>
  parsed.analysisData.readings && typeof parsed.analysisData.readings === "object"
    ? (parsed.analysisData.readings as Record<string, unknown>)
    : {};

export async function importAppointmentReport(
  fastify: FastifyInstance,
  documentQueue: Queue,
  tenantId: string,
  appointmentId: string,
  scope: ApptScope,
  file: { buffer: Buffer; filename: string; mimetype: string },
): Promise<ImportReportResult> {
  const appointment = await fastify.prisma.appointment.findFirst({
    where: { id: appointmentId, tenantId, deletedAt: null, ...apptVisibilityWhere(scope) },
    select: {
      id: true,
      type: true,
      date: true,
      clientId: true,
      employeeId: true,
      equipmentId: true,
      equipmentRevisionId: true,
      completionDataJson: true,
    },
  });
  if (!appointment) throw fastify.httpErrors.notFound("Appointment not found");
  if (!canSeeEmployee(scope, appointment.employeeId)) {
    throw fastify.httpErrors.forbidden("Nu poți importa raportul pentru programarea altui tehnician");
  }

  const settings = await getReportSourcesSettings(fastify.prisma, tenantId);
  const cfg = getReportTypeConfig(settings, appointment.type);
  if (!cfg) throw fastify.httpErrors.badRequest("Tipul programării nu acceptă import de raport");

  // 1. Fișierul, înainte de orice (nu pierdem niciodată PDF-ul).
  const s3Key = `${tenantId}/appointments/${appointmentId}/reports/${Date.now()}-${safeS3Filename(file.filename)}`;
  await uploadFile(s3Key, file.buffer, file.mimetype || "application/pdf");

  // 2. Sursa: strategia „attach" nu extrage nimic; altfel cea configurată sau detecția.
  let text = "";
  try {
    text = await extractPdfText(file.buffer);
  } catch (err) {
    fastify.log.warn({ err, appointmentId }, "import-report: pdftotext failed");
  }
  let source: ReportSource;
  let score = 0;
  if (cfg.strategy === "attach") {
    source = getSource(ATTACH_ONLY_SOURCE_ID)!;
  } else if (cfg.sourceId !== AUTO_SOURCE && getSource(cfg.sourceId)) {
    source = getSource(cfg.sourceId)!;
    score = source.detect(text);
  } else {
    ({ source, score } = detectSource(text));
  }

  const parsed = await source.parse({
    buffer: file.buffer,
    text,
    mapping: settings.sourceMappings[source.id],
  });
  parsed.analysisData._source = source.id;
  if (cfg.requiredFields.length) {
    const have = new Set([
      ...Object.keys(readingsOf(parsed)),
      ...Object.entries(parsed).filter(([k, v]) => k !== "rawText" && k !== "analysisData" && v).map(([k]) => k),
      ...Object.keys(parsed.analysisData),
    ]);
    const missing = cfg.requiredFields.filter((f) => !have.has(f));
    if (missing.length) parsed.analysisData._missingFields = missing;
  }

  const result: ImportReportResult = {
    strategy: cfg.strategy,
    sourceId: source.id,
    sourceLabel: source.label,
    score,
    readings: readingsOf(parsed),
    prefill: prefillFromAnalysisData(parsed.analysisData),
  };

  if (appointment.type === "revizie") {
    result.revisionId = await upsertRevision(fastify, documentQueue, tenantId, appointment, parsed, s3Key, file.filename);
  } else {
    const doc = await fastify.prisma.document.create({
      data: {
        tenantId,
        name: `Raport analizor — ${source.label}`,
        status: "COMPLETED",
        s3Key,
        appointmentId,
        contextJson: {
          appointmentId,
          reportSource: source.id,
          readings: result.readings,
          fileName: file.filename,
        } as Prisma.InputJsonValue,
        ...(appointment.clientId && { clients: { create: { clientId: appointment.clientId } } }),
      },
      select: { id: true },
    });
    result.documentId = doc.id;
  }

  return result;
}

/** Revizia programării: cea legată, una recentă nelegată pe echipament, sau una nouă. */
async function upsertRevision(
  fastify: FastifyInstance,
  documentQueue: Queue,
  tenantId: string,
  appointment: {
    id: string;
    date: Date;
    clientId: string | null;
    equipmentId: string | null;
    equipmentRevisionId: string | null;
  },
  parsed: ParsedRevision,
  s3Key: string,
  fileName: string,
): Promise<string> {
  const prisma = fastify.prisma;

  let equipmentId = appointment.equipmentId;
  if (!equipmentId) {
    if (!appointment.clientId) {
      throw fastify.httpErrors.badRequest("Programarea nu are client sau centrală asociată");
    }
    const equipment = await matchOrCreateEquipment(prisma, appointment.clientId, {
      equipmentName: parsed.equipmentName,
      equipmentSerial: parsed.equipmentSerial,
      fuel: typeof parsed.analysisData.combustibil === "string" ? parsed.analysisData.combustibil : null,
    });
    equipmentId = equipment.id;
  }

  const data = {
    status: "COMPLETED",
    s3Key,
    fileName,
    sourceEmailId: `import:${appointment.id}`,
    ...revisionDataFromParsed(parsed),
  };

  let revisionId = appointment.equipmentRevisionId;
  if (revisionId) {
    const existing = await prisma.equipmentRevision.findUnique({
      where: { id: revisionId },
      select: { revisionDate: true },
    });
    await prisma.equipmentRevision.update({
      where: { id: revisionId },
      data: { ...data, revisionDate: parsed.revisionDate ?? existing?.revisionDate ?? appointment.date },
    });
  } else {
    // Ca la finalizare: o revizie recentă încă nelegată de o programare (ex. venită
    // pe e-mail) e a acestei programări; altfel creăm una.
    const recent = await prisma.equipmentRevision.findFirst({
      where: {
        equipmentId,
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 3600_000) },
        appointment: { is: null },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, revisionDate: true },
    });
    if (recent) {
      revisionId = recent.id;
      await prisma.equipmentRevision.update({
        where: { id: revisionId },
        data: { ...data, revisionDate: parsed.revisionDate ?? recent.revisionDate },
      });
    } else {
      const created = await prisma.equipmentRevision.create({
        data: { equipmentId, revisionDate: parsed.revisionDate ?? appointment.date, ...data },
        select: { id: true },
      });
      revisionId = created.id;
    }
  }

  await prisma.appointment.update({
    where: { id: appointment.id },
    data: { equipmentId, equipmentRevisionId: revisionId },
  });

  await queueIscirIfReportExists(fastify, documentQueue, tenantId, revisionId);
  return revisionId;
}
