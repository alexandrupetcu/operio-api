import type { FastifyInstance } from "fastify";
import type { Queue } from "bullmq";
import type { CreateRevisionInput, UpdateRevisionInput } from "./equipment-revisions.schema.js";
import { revisionSource, type ParsedRevision } from "../../lib/report-sources/index.js";

/** Textul brut al raportului se ține pentru re-parsare/depanare — nu nelimitat. */
export const RAW_TEXT_MAX_CHARS = 200 * 1024;
export const capRawText = (text: string | null | undefined): string | null | undefined =>
  typeof text === "string" && text.length > RAW_TEXT_MAX_CHARS ? text.slice(0, RAW_TEXT_MAX_CHARS) : text;

/** Coloanele EquipmentRevision alimentate dintr-un raport parsat (fără dată/status/fișier). */
export function revisionDataFromParsed(parsed: ParsedRevision) {
  return {
    operatorName: parsed.operator.name,
    operatorAddress: parsed.operator.address,
    operatorPhone: parsed.operator.phone,
    operatorEmail: parsed.operator.email,
    analyzerName: parsed.analyzer.name,
    analyzerSerial: parsed.analyzer.serial,
    location: parsed.location,
    pdfEquipmentName: parsed.equipmentName,
    pdfEquipmentSerial: parsed.equipmentSerial,
    pdfClientAddress: parsed.clientAddress,
    analysisData: parsed.analysisData as never,
    rawText: capRawText(parsed.rawText),
  };
}

/**
 * (Re)generează documentul ISCIR al unei revizii dacă programarea legată are
 * deja raportul tehnicianului (`completionDataJson`). Refolosește documentul
 * existent (reset la PENDING) sau creează unul. Întoarce true dacă a pus un job
 * în coadă. Folosit de upload-pdf și de importul din teren.
 */
export async function queueIscirIfReportExists(
  fastify: FastifyInstance,
  documentQueue: Queue,
  tenantId: string,
  revisionId: string,
): Promise<boolean> {
  const rev = await fastify.prisma.equipmentRevision.findUnique({
    where: { id: revisionId },
    select: { iscirDocumentId: true, equipment: { select: { clientId: true } } },
  });
  if (!rev) return false;

  const linkedApt = await fastify.prisma.appointment.findFirst({
    where: { equipmentRevisionId: revisionId, deletedAt: null },
    select: { completionDataJson: true },
  });
  if (!linkedApt?.completionDataJson) return false;

  const tpl = await fastify.prisma.documentTemplate.findFirst({
    where: { categoryCode: "REVIZIE_CENTRALA", OR: [{ tenantId }, { tenantId: null }], isActive: true },
    select: { id: true },
  });
  if (!tpl) return false;

  let documentId = rev.iscirDocumentId;
  if (documentId) {
    await fastify.prisma.document.update({
      where: { id: documentId },
      data: { status: "PENDING", errorMessage: null },
    });
  } else {
    const doc = await fastify.prisma.document.create({
      data: {
        tenantId,
        templateId: tpl.id,
        name: "Raport Revizie Centrală (ISCIR)",
        status: "PENDING",
        clients: { create: { clientId: rev.equipment.clientId } },
      },
    });
    documentId = doc.id;
    await fastify.prisma.equipmentRevision.update({
      where: { id: revisionId },
      data: { iscirDocumentId: documentId },
    });
  }
  await documentQueue.add("generate", {
    documentId,
    tenantId,
    clientId: rev.equipment.clientId,
    templateId: tpl.id,
    revisionId,
  });
  return true;
}

/** Verify equipment belongs to client belongs to tenant. Returns equipment or throws 404 */
export async function verifyOwnership(
  fastify: FastifyInstance,
  tenantId: string,
  clientId: string,
  equipmentId: string
) {
  const equipment = await fastify.prisma.equipment.findFirst({
    where: {
      id: equipmentId,
      clientId,
      client: { tenantId },
    },
  });
  if (!equipment) throw fastify.httpErrors.notFound("Equipment not found");
  return equipment;
}

/** Câmpurile unei revizii în liste (pe echipament sau pe tot clientul). */
const revisionListSelect = {
  id: true,
  revisionDate: true,
  status: true,
  fileName: true,
  operatorName: true,
  operatorAddress: true,
  operatorPhone: true,
  operatorEmail: true,
  analyzerName: true,
  analyzerSerial: true,
  location: true,
  pdfEquipmentName: true,
  pdfEquipmentSerial: true,
  pdfClientAddress: true,
  analysisData: true,
  notes: true,
  s3Key: true,
  iscirDocumentId: true,
  sourceEmailId: true,
  createdAt: true,
  // Vizita din care a rezultat revizia: depunerea / înregistrarea raportului la OS.
  appointment: {
    select: {
      id: true,
      type: true,
      date: true,
      status: true,
      completedAt: true,
      osSubmittedAt: true,
      osRegistrationNumber: true,
      osRegisteredAt: true,
      osClientNotifiedAt: true,
      // Doar pentru `decision` (vezi `withIscirDocuments`); raportul întreg nu pleacă în listă.
      completionDataJson: true,
    },
  },
} as const;

/** Decizia din raportul de revizie centrală (`conclusions.decision`), dacă vizita are unul. */
export function decisionOf(report: unknown): "admis" | "respins" | null {
  const d = report && typeof report === "object" ? (report as { conclusions?: { decision?: unknown } }).conclusions?.decision : null;
  return d === "admis" || d === "respins" ? d : null;
}

type ApptWithReport = { completionDataJson?: unknown } | null | undefined;
/** Vizita din listă: `completionDataJson` înlocuit cu `decision`. */
function slimAppointment<A extends ApptWithReport>(appt: A) {
  if (!appt) return appt as Exclude<A, { completionDataJson?: unknown }> | null;
  const { completionDataJson, ...rest } = appt;
  return { ...rest, decision: decisionOf(completionDataJson) };
}

async function withIscirDocuments<T extends { iscirDocumentId: string | null; analysisData: unknown; analyzerName: string | null; appointment?: ApptWithReport }>(
  fastify: FastifyInstance,
  tenantId: string,
  revisions: T[]
) {
  // Fetch linked ISCIR documents in one query
  const docIds = revisions.map((r) => r.iscirDocumentId).filter((id): id is string => !!id);
  const docs = docIds.length
    ? await fastify.prisma.document.findMany({
        where: { id: { in: docIds }, tenantId },
        select: { id: true, name: true, status: true, s3Key: true },
      })
    : [];
  const docMap = new Map(docs.map((d) => [d.id, d]));

  return revisions.map((r) => ({
    ...r,
    appointment: slimAppointment(r.appointment),
    source: revisionSource(r),
    iscirDocument: r.iscirDocumentId ? docMap.get(r.iscirDocumentId) ?? null : null,
  }));
}

export async function listByEquipment(
  fastify: FastifyInstance,
  tenantId: string,
  clientId: string,
  equipmentId: string
) {
  await verifyOwnership(fastify, tenantId, clientId, equipmentId);

  const revisions = await fastify.prisma.equipmentRevision.findMany({
    where: { equipmentId },
    orderBy: { revisionDate: "desc" },
    take: 500,
    select: revisionListSelect,
  });
  return withIscirDocuments(fastify, tenantId, revisions);
}

/** Toate reviziile clientului, de pe toate echipamentele — tabul „Revizii” din fișa clientului. */
export async function listByClient(fastify: FastifyInstance, tenantId: string, clientId: string) {
  const client = await fastify.prisma.client.findFirst({ where: { id: clientId, tenantId }, select: { id: true } });
  if (!client) throw fastify.httpErrors.notFound("Client not found");

  const revisions = await fastify.prisma.equipmentRevision.findMany({
    where: { equipment: { clientId } },
    orderBy: { revisionDate: "desc" },
    take: 500,
    select: {
      ...revisionListSelect,
      equipment: { select: { id: true, name: true, internalName: true, serial: true, location: true } },
    },
  });
  return withIscirDocuments(fastify, tenantId, revisions);
}

export async function getById(
  fastify: FastifyInstance,
  tenantId: string,
  clientId: string,
  equipmentId: string,
  revisionId: string
) {
  await verifyOwnership(fastify, tenantId, clientId, equipmentId);

  const revision = await fastify.prisma.equipmentRevision.findFirst({
    where: { id: revisionId, equipmentId },
  });
  if (!revision) throw fastify.httpErrors.notFound("Revision not found");
  return { ...revision, source: revisionSource(revision) };
}

export async function create(
  fastify: FastifyInstance,
  tenantId: string,
  clientId: string,
  equipmentId: string,
  input: CreateRevisionInput,
  status: string = "COMPLETED"
) {
  await verifyOwnership(fastify, tenantId, clientId, equipmentId);

  return fastify.prisma.equipmentRevision.create({
    data: {
      equipmentId,
      revisionDate: new Date(input.revisionDate),
      status,
      s3Key: input.s3Key,
      fileName: input.fileName,
      operatorName: input.operatorName,
      operatorAddress: input.operatorAddress,
      operatorPhone: input.operatorPhone,
      operatorEmail: input.operatorEmail,
      analyzerName: input.analyzerName,
      analyzerSerial: input.analyzerSerial,
      analysisData: (input.analysisData ?? undefined) as any,
      rawText: capRawText(input.rawText),
      notes: input.notes,
    },
  });
}

export async function update(
  fastify: FastifyInstance,
  tenantId: string,
  clientId: string,
  equipmentId: string,
  revisionId: string,
  input: UpdateRevisionInput
) {
  await verifyOwnership(fastify, tenantId, clientId, equipmentId);

  const existing = await fastify.prisma.equipmentRevision.findFirst({
    where: { id: revisionId, equipmentId },
  });
  if (!existing) throw fastify.httpErrors.notFound("Revision not found");

  return fastify.prisma.equipmentRevision.update({
    where: { id: revisionId },
    data: {
      ...(input.revisionDate !== undefined && {
        revisionDate: new Date(input.revisionDate),
      }),
      ...(input.operatorName !== undefined && { operatorName: input.operatorName }),
      ...(input.operatorAddress !== undefined && { operatorAddress: input.operatorAddress }),
      ...(input.operatorPhone !== undefined && { operatorPhone: input.operatorPhone }),
      ...(input.operatorEmail !== undefined && { operatorEmail: input.operatorEmail }),
      ...(input.analyzerName !== undefined && { analyzerName: input.analyzerName }),
      ...(input.analyzerSerial !== undefined && { analyzerSerial: input.analyzerSerial }),
      ...(input.analysisData !== undefined && { analysisData: (input.analysisData ?? undefined) as any }),
      ...(input.notes !== undefined && { notes: input.notes }),
    },
  });
}

export async function remove(
  fastify: FastifyInstance,
  tenantId: string,
  clientId: string,
  equipmentId: string,
  revisionId: string
) {
  await verifyOwnership(fastify, tenantId, clientId, equipmentId);

  const revision = await fastify.prisma.equipmentRevision.findFirst({
    where: { id: revisionId, equipmentId },
  });
  if (!revision) throw fastify.httpErrors.notFound("Revision not found");

  // Delete S3 file if exists
  if (revision.s3Key) {
    const { deleteFile } = await import("../../lib/s3.js");
    await deleteFile(revision.s3Key).catch(() => {});
  }

  await fastify.prisma.equipmentRevision.delete({ where: { id: revisionId } });
  return { success: true };
}
