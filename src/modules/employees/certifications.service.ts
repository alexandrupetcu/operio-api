import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CERT_TYPE_CODES, authorityOf, certDisplayName, certType } from "../../lib/certifications.js";
import { getPresignedUrl } from "../../lib/s3.js";
import { logAudit } from "../../lib/audit.js";
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
    // Pe ce ștampilă e trecută: id-ul uneia existente, „new” (una nouă, goală) sau null.
    stampId: z.string().min(1).nullable().optional(),
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
    stampId: z.string().min(1).nullable().optional(),
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
  stampId: true,
  stamp: { select: { id: true, name: true, s3Key: true } },
  notes: true,
  createdAt: true,
  updatedAt: true,
} as const;

type CertRow = { stamp: { s3Key: string | null } | null; type: string; label: string | null };

async function present<T extends CertRow>(c: T) {
  return {
    ...c,
    displayName: certDisplayName(c),
    stampUrl: c.stamp?.s3Key ? await getPresignedUrl(c.stamp.s3Key) : null,
  };
}

const auditLabel = (c: { type: string; label: string | null; number?: string | null }) =>
  ({ code: certType(c.type)?.short || certDisplayName(c), number: c.number ?? null });

/**
 * `stampId` din formular → id-ul real: „new” creează o ștampilă goală a autorității
 * certificării; un id existent trebuie să fie al aceluiași angajat și al aceleiași
 * autorități. `undefined` = nu se schimbă.
 */
async function resolveStampId(
  fastify: FastifyInstance,
  tenantId: string,
  employeeId: string,
  type: string,
  stampId: string | null | undefined,
): Promise<string | null | undefined> {
  if (stampId === undefined || stampId === null) return stampId;
  const authority = authorityOf(type);
  if (stampId === "new") {
    const s = await fastify.prisma.employeeStamp.create({
      data: { tenantId, employeeId, authority, name: `Ștampilă ${authority === "Altele" ? certType(type)?.short || "personală" : authority}` },
    });
    return s.id;
  }
  const s = await fastify.prisma.employeeStamp.findFirst({ where: { id: stampId, employeeId, tenantId }, select: { authority: true } });
  if (!s) throw fastify.httpErrors.notFound("Ștampila nu există");
  if (s.authority !== authority) throw fastify.httpErrors.badRequest(`Certificarea ${authority} nu poate sta pe o ștampilă ${s.authority}`);
  return stampId;
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
  actorUserId: string | null = null,
) {
  await employeeOrThrow(fastify, tenantId, employeeId);
  const stampId = await resolveStampId(fastify, tenantId, employeeId, input.type, input.stampId);
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
      stampId: stampId ?? null,
    },
    select: certSelect,
  });
  await logAudit(fastify, tenantId, actorUserId, "employee", employeeId, "certification.created", undefined, auditLabel(row));
  invalidateReadiness(tenantId);
  return present(row);
}

export async function updateCertification(
  fastify: FastifyInstance,
  tenantId: string,
  employeeId: string,
  certId: string,
  input: CertificationUpdate,
  actorUserId: string | null = null,
) {
  const current = await certOrThrow(fastify, tenantId, employeeId, certId);
  const type = input.type ?? current.type;
  const label = input.label !== undefined ? input.label : current.label;
  if (type === "other" && !label) throw fastify.httpErrors.badRequest("Dă un nume certificării");
  let stampId = await resolveStampId(fastify, tenantId, employeeId, type, input.stampId);
  // Tipul s-a schimbat în altă autoritate: nu mai poate sta pe ștampila veche.
  if (stampId === undefined && current.stampId && authorityOf(type) !== authorityOf(current.type)) stampId = null;
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
      ...(stampId !== undefined && { stampId }),
    },
    select: certSelect,
  });
  await logAudit(fastify, tenantId, actorUserId, "employee", employeeId, "certification.updated", auditLabel(current), auditLabel(row));
  invalidateReadiness(tenantId);
  return present(row);
}

export async function deleteCertification(
  fastify: FastifyInstance,
  tenantId: string,
  employeeId: string,
  certId: string,
  actorUserId: string | null = null,
) {
  const current = await certOrThrow(fastify, tenantId, employeeId, certId);
  // Imaginea ștampilei stă pe ștampilă (care poate include și alte certificări) — rămâne.
  await fastify.prisma.employeeCertification.delete({ where: { id: certId } });
  await logAudit(fastify, tenantId, actorUserId, "employee", employeeId, "certification.deleted", auditLabel(current));
  invalidateReadiness(tenantId);
  return { deleted: true };
}
