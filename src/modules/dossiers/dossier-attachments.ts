import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { uploadFile, deleteFile } from "../../lib/s3.js";
import { safeS3Filename, uploadContentType } from "../../lib/safe-filename.js";
import type { MaterialDocData } from "../../lib/material-doc.js";

/**
 * Documentele atașate la un dosar — facturi, certificate de calitate, declarații de
 * conformitate, avize — păstrate în aplicație (Document cu status UPLOADED, legat de dosar)
 * și descărcabile oricând. `target` spune lângă ce secțiune stau (țeava, un tabel de
 * materiale, avizele), `kind` ce fel de document e. La încărcare se pot citi automat.
 */
export const ATTACHMENT_TARGETS = ["teava", "materiale", "materiale_conducta", "materiale_srm", "avize"] as const;
export const ATTACHMENT_KINDS = ["factura", "certificat_calitate", "declaratie_conformitate", "aviz", "altul"] as const;
export type AttachmentTarget = (typeof ATTACHMENT_TARGETS)[number];
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

const MAX_BYTES = 20 * 1024 * 1024;
const ACCEPTED = /\.(pdf|png|jpe?g|webp|heic)$/i;

type Reader = (input: { buffer: Buffer; mimetype: string; filename: string }) => Promise<MaterialDocData>;

async function findDossier(fastify: FastifyInstance, tenantId: string, id: string) {
  const d = await fastify.prisma.project.findFirst({ where: { id, tenantId }, select: { id: true } });
  if (!d) throw fastify.httpErrors.notFound("Dosarul nu a fost găsit");
  return d;
}

const meta = (ctx: Prisma.JsonValue | null) => {
  const a = (ctx as { dossierAttachment?: { target: AttachmentTarget; kind: AttachmentKind } } | null)?.dossierAttachment;
  return a ?? null;
};

export async function upload(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string,
  dossierId: string,
  opts: { target: AttachmentTarget; kind: AttachmentKind; read: boolean },
  file: { buffer: Buffer; filename: string; mimetype: string },
  reader: Reader,
) {
  await findDossier(fastify, tenantId, dossierId);
  if (!ACCEPTED.test(file.filename)) throw fastify.httpErrors.badRequest("Se pot atașa PDF-uri și poze (JPG, PNG, WEBP, HEIC).");
  if (!file.buffer.length) throw fastify.httpErrors.badRequest("Fișierul este gol.");
  if (file.buffer.length > MAX_BYTES) throw fastify.httpErrors.payloadTooLarge("Fișierul depășește 20 MB.");

  const s3Key = `${tenantId}/projects/${dossierId}/attachments/${Date.now()}-${safeS3Filename(file.filename)}`;
  await uploadFile(s3Key, file.buffer, uploadContentType(file.filename));
  const doc = await fastify.prisma.document.create({
    data: {
      tenantId,
      generatedById: userId,
      name: file.filename,
      s3Key,
      status: "UPLOADED",
      contextJson: { dossierAttachment: { target: opts.target, kind: opts.kind } },
      projects: { create: { projectId: dossierId } },
    },
  });

  let extracted: MaterialDocData | null = null;
  let readError: string | null = null;
  if (opts.read) {
    try {
      extracted = await reader({ buffer: file.buffer, mimetype: uploadContentType(file.filename), filename: file.filename });
    } catch (err) {
      // Fișierul rămâne atașat; câmpurile se completează de mână.
      readError = err instanceof Error ? err.message : String(err);
      fastify.log.warn({ err, documentId: doc.id }, "dossier attachment: read failed");
    }
  }
  return { attachment: { id: doc.id, name: doc.name, target: opts.target, kind: opts.kind, createdAt: doc.createdAt }, extracted, readError };
}

export async function list(fastify: FastifyInstance, tenantId: string, dossierId: string) {
  await findDossier(fastify, tenantId, dossierId);
  const docs = await fastify.prisma.document.findMany({
    where: { tenantId, status: "UPLOADED", projects: { some: { projectId: dossierId } }, contextJson: { path: ["dossierAttachment"], not: "null" as never } },
    select: { id: true, name: true, contextJson: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  return docs.flatMap((d) => {
    const m = meta(d.contextJson);
    return m ? [{ id: d.id, name: d.name, target: m.target, kind: m.kind, createdAt: d.createdAt }] : [];
  });
}

export async function remove(fastify: FastifyInstance, tenantId: string, dossierId: string, documentId: string) {
  await findDossier(fastify, tenantId, dossierId);
  const doc = await fastify.prisma.document.findFirst({
    where: { id: documentId, tenantId, projects: { some: { projectId: dossierId } } },
    select: { id: true, s3Key: true, contextJson: true },
  });
  if (!doc || !meta(doc.contextJson)) throw fastify.httpErrors.notFound("Atașamentul nu a fost găsit");
  await fastify.prisma.document.delete({ where: { id: doc.id } });
  if (doc.s3Key) await deleteFile(doc.s3Key).catch(() => {});
  return { success: true };
}
