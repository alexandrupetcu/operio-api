import type { FastifyInstance } from "fastify";
import type { Queue } from "bullmq";
import type { CreateRevisionInput, UpdateRevisionInput } from "./equipment-revisions.schema.js";
import { revisionSource, type ParsedRevision } from "../../lib/report-sources/index.js";

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
    rawText: parsed.rawText,
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
async function verifyOwnership(
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
    select: {
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
    },
  });

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
    source: revisionSource(r),
    iscirDocument: r.iscirDocumentId ? docMap.get(r.iscirDocumentId) ?? null : null,
  }));
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
      rawText: input.rawText,
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
