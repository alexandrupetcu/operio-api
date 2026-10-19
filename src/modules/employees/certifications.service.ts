import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CERT_TYPE_CODES, certDisplayName } from "../../lib/certifications.js";
import { uploadFile, deleteFile, getPresignedUrl } from "../../lib/s3.js";
import { removeWhiteBackground } from "../../lib/image.js";
import { invalidateReadiness } from "../tenant/readiness.js";

const optText = (max: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(max).nullable().optional());
const optDate = z.preprocess(
  (v) => (v === "" ? null : v),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data trebuie să fie în formatul AAAA-LL-ZZ").nullable().optional(),
);

export const certificationInputSchema = z
  .object({
    type: z.enum(CERT_TYPE_CODES),
    label: optText(120),
    number: optText(80),
    domain: optText(120),
    issuedAt: optDate,
    expiresAt: optDate,
    notes: optText(500),
  })
  .refine((c) => c.type !== "other" || !!c.label, { message: "Dă un nume certificării", path: ["label"] });

export const certificationUpdateSchema = z
  .object({
    type: z.enum(CERT_TYPE_CODES).optional(),
    label: optText(120),
    number: optText(80),
    domain: optText(120),
    issuedAt: optDate,
    expiresAt: optDate,
    notes: optText(500),
  });

export type CertificationInput = z.infer<typeof certificationInputSchema>;
export type CertificationUpdate = z.infer<typeof certificationUpdateSchema>;

const toDate = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : new Date(`${v}T00:00:00.000Z`));

const certSelect = {
  id: true,
  employeeId: true,
  type: true,
  label: true,
  number: true,
  domain: true,
  issuedAt: true,
  expiresAt: true,
  stampS3Key: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
} as const;

type CertRow = { stampS3Key: string | null; type: string; label: string | null };

async function present<T extends CertRow>(c: T) {
  return {
    ...c,
    displayName: certDisplayName(c),
    stampUrl: c.stampS3Key ? await getPresignedUrl(c.stampS3Key) : null,
  };
}

async function employeeOrThrow(fastify: FastifyInstance, tenantId: string, employeeId: string) {
  const e = await fastify.prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { id: true } });
  if (!e) throw fastify.httpErrors.notFound("Angajatul nu există");
  return e;
}

async function certOrThrow(fastify: FastifyInstance, tenantId: string, employeeId: string, certId: string) {
  const c = await fastify.prisma.employeeCertification.findFirst({
    where: { id: certId, employeeId, tenantId },
    select: certSelect,
  });
  if (!c) throw fastify.httpErrors.notFound("Certificarea nu există");
  return c;
}

export async function listCertifications(fastify: FastifyInstance, tenantId: string, employeeId: string) {
  await employeeOrThrow(fastify, tenantId, employeeId);
  const rows = await fastify.prisma.employeeCertification.findMany({
    where: { tenantId, employeeId },
    select: certSelect,
    orderBy: [{ createdAt: "asc" }],
  });
  return Promise.all(rows.map(present));
}

export async function createCertification(
  fastify: FastifyInstance,
  tenantId: string,
  employeeId: string,
  input: CertificationInput,
) {
  await employeeOrThrow(fastify, tenantId, employeeId);
  const row = await fastify.prisma.employeeCertification.create({
    data: {
      tenantId,
      employeeId,
      type: input.type,
      label: input.type === "other" ? input.label ?? null : null,
      number: input.number ?? null,
      domain: input.domain ?? null,
      issuedAt: toDate(input.issuedAt) ?? null,
      expiresAt: toDate(input.expiresAt) ?? null,
      notes: input.notes ?? null,
    },
    select: certSelect,
  });
  invalidateReadiness(tenantId);
  return present(row);
}

export async function updateCertification(
  fastify: FastifyInstance,
  tenantId: string,
  employeeId: string,
  certId: string,
  input: CertificationUpdate,
) {
  const current = await certOrThrow(fastify, tenantId, employeeId, certId);
  const type = input.type ?? current.type;
  const label = input.label !== undefined ? input.label : current.label;
  if (type === "other" && !label) throw fastify.httpErrors.badRequest("Dă un nume certificării");
  const row = await fastify.prisma.employeeCertification.update({
    where: { id: certId },
    data: {
      type,
      label: type === "other" ? label : null,
      ...(input.number !== undefined && { number: input.number }),
      ...(input.domain !== undefined && { domain: input.domain }),
      ...(input.issuedAt !== undefined && { issuedAt: toDate(input.issuedAt) }),
      ...(input.expiresAt !== undefined && { expiresAt: toDate(input.expiresAt) }),
      ...(input.notes !== undefined && { notes: input.notes }),
    },
    select: certSelect,
  });
  invalidateReadiness(tenantId);
  return present(row);
}

export async function deleteCertification(fastify: FastifyInstance, tenantId: string, employeeId: string, certId: string) {
  const current = await certOrThrow(fastify, tenantId, employeeId, certId);
  await fastify.prisma.employeeCertification.delete({ where: { id: certId } });
  if (current.stampS3Key) await deleteFile(current.stampS3Key).catch(() => {});
  invalidateReadiness(tenantId);
  return { deleted: true };
}

/** Ștampila certificării (fundalul alb devine transparent, ca la ștampilele firmei). */
export async function setCertificationStamp(
  fastify: FastifyInstance,
  tenantId: string,
  employeeId: string,
  certId: string,
  image: Buffer,
) {
  const current = await certOrThrow(fastify, tenantId, employeeId, certId);
  const png = await removeWhiteBackground(image);
  // Cheie nouă la fiecare încărcare: URL-urile vechi (cache) nu arată imaginea veche.
  const key = `${tenantId}/employees/${employeeId}/cert-${certId}-${Date.now()}.png`;
  await uploadFile(key, png, "image/png");
  await fastify.prisma.employeeCertification.update({ where: { id: certId }, data: { stampS3Key: key } });
  if (current.stampS3Key) await deleteFile(current.stampS3Key).catch(() => {});
  invalidateReadiness(tenantId);
  return present({ ...current, stampS3Key: key });
}

export async function removeCertificationStamp(fastify: FastifyInstance, tenantId: string, employeeId: string, certId: string) {
  const current = await certOrThrow(fastify, tenantId, employeeId, certId);
  if (current.stampS3Key) {
    await fastify.prisma.employeeCertification.update({ where: { id: certId }, data: { stampS3Key: null } });
    await deleteFile(current.stampS3Key).catch(() => {});
  }
  invalidateReadiness(tenantId);
  return present({ ...current, stampS3Key: null });
}
