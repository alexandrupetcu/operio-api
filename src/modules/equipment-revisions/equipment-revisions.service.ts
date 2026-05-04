import type { FastifyInstance } from "fastify";
import type { CreateRevisionInput, UpdateRevisionInput } from "./equipment-revisions.schema.js";

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
  return revision;
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
