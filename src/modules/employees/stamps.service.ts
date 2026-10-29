import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { STAMP_AUTHORITIES, authorityOf } from "../../lib/certifications.js";
import { uploadFile, deleteFile, getPresignedUrl } from "../../lib/s3.js";
import { prepareStampImage, type StampImageMode } from "../../lib/stamp-image.js";
import { logAudit } from "../../lib/audit.js";
import { invalidateReadiness } from "../tenant/readiness.js";

/**
 * Ștampilele personale ale unui angajat (EmployeeStamp). O ștampilă are o
 * autoritate (ANRE / ISCIR / Construcții / Altele) și include certificări doar ale
 * aceleiași autorități; o certificare stă pe cel mult o ștampilă (`stampId`).
 * Pe document se pune ștampila pe care e trecută certificarea folosită.
 */

export const stampInputSchema = z.object({
  name: z.string().trim().min(1, "Dă un nume ștampilei").max(80),
  authority: z.enum(STAMP_AUTHORITIES as [string, ...string[]]),
  certIds: z.array(z.string().min(1)).max(50).optional(),
});
export const stampUpdateSchema = stampInputSchema.partial();
export type StampInput = z.infer<typeof stampInputSchema>;
export type StampUpdate = z.infer<typeof stampUpdateSchema>;

const stampSelect = {
  id: true,
  employeeId: true,
  name: true,
  authority: true,
  s3Key: true,
  createdAt: true,
  updatedAt: true,
  certifications: { select: { id: true, type: true, label: true, number: true }, orderBy: { createdAt: "asc" as const } },
} as const;

async function present<T extends { s3Key: string | null }>(s: T) {
  return { ...s, imageUrl: s.s3Key ? await getPresignedUrl(s.s3Key) : null };
}

async function employeeOrThrow(fastify: FastifyInstance, tenantId: string, employeeId: string) {
  const e = await fastify.prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { id: true } });
  if (!e) throw fastify.httpErrors.notFound("Angajatul nu există");
}

async function stampOrThrow(fastify: FastifyInstance, tenantId: string, employeeId: string, stampId: string) {
  const s = await fastify.prisma.employeeStamp.findFirst({ where: { id: stampId, employeeId, tenantId }, select: stampSelect });
  if (!s) throw fastify.httpErrors.notFound("Ștampila nu există");
  return s;
}

/** Certificările date trebuie să fie ale angajatului și ale autorității ștampilei. */
async function assertCerts(fastify: FastifyInstance, tenantId: string, employeeId: string, certIds: string[], authority: string) {
  if (certIds.length === 0) return;
  const certs = await fastify.prisma.employeeCertification.findMany({
    where: { id: { in: certIds }, employeeId, tenantId },
    select: { id: true, type: true },
  });
  if (certs.length !== new Set(certIds).size) throw fastify.httpErrors.notFound("Certificarea nu există");
  const wrong = certs.find((c) => authorityOf(c.type) !== authority);
  if (wrong) throw fastify.httpErrors.badRequest(`O ștampilă ${authority} poate include doar certificări ${authority}`);
}

export async function listStamps(fastify: FastifyInstance, tenantId: string, employeeId: string) {
  await employeeOrThrow(fastify, tenantId, employeeId);
  const rows = await fastify.prisma.employeeStamp.findMany({
    where: { tenantId, employeeId },
    select: stampSelect,
    orderBy: { createdAt: "asc" },
  });
  return Promise.all(rows.map(present));
}

export async function createStamp(
  fastify: FastifyInstance,
  tenantId: string,
  employeeId: string,
  input: StampInput,
  actorUserId: string | null,
) {
  await employeeOrThrow(fastify, tenantId, employeeId);
  const certIds = input.certIds ?? [];
  await assertCerts(fastify, tenantId, employeeId, certIds, input.authority);
  const stamp = await fastify.prisma.$transaction(async (tx) => {
    const s = await tx.employeeStamp.create({ data: { tenantId, employeeId, name: input.name, authority: input.authority } });
    if (certIds.length) await tx.employeeCertification.updateMany({ where: { id: { in: certIds }, employeeId }, data: { stampId: s.id } });
    return tx.employeeStamp.findUniqueOrThrow({ where: { id: s.id }, select: stampSelect });
  });
  await logAudit(fastify, tenantId, actorUserId, "employee", employeeId, "stamp.created", undefined, { name: stamp.name, authority: stamp.authority });
  invalidateReadiness(tenantId);
  return present(stamp);
}

export async function updateStamp(
  fastify: FastifyInstance,
  tenantId: string,
  employeeId: string,
  stampId: string,
  input: StampUpdate,
  actorUserId: string | null,
) {
  const current = await stampOrThrow(fastify, tenantId, employeeId, stampId);
  const authority = input.authority ?? current.authority;
  // Fără listă nouă: păstrăm certificările care se potrivesc noii autorități.
  const certIds = input.certIds ?? current.certifications.filter((c) => authorityOf(c.type) === authority).map((c) => c.id);
  await assertCerts(fastify, tenantId, employeeId, certIds, authority);

  const stamp = await fastify.prisma.$transaction(async (tx) => {
    await tx.employeeStamp.update({
      where: { id: stampId },
      data: { ...(input.name !== undefined && { name: input.name }), authority },
    });
    // Scoase de pe ștampilă → fără ștampilă; incluse → mutate aici (de pe alta, dacă era).
    await tx.employeeCertification.updateMany({ where: { stampId, id: { notIn: certIds } }, data: { stampId: null } });
    if (certIds.length) await tx.employeeCertification.updateMany({ where: { id: { in: certIds }, employeeId }, data: { stampId } });
    return tx.employeeStamp.findUniqueOrThrow({ where: { id: stampId }, select: stampSelect });
  });
  await logAudit(fastify, tenantId, actorUserId, "employee", employeeId, "stamp.updated", { name: current.name }, { name: stamp.name });
  invalidateReadiness(tenantId);
  return present(stamp);
}

export async function deleteStamp(
  fastify: FastifyInstance,
  tenantId: string,
  employeeId: string,
  stampId: string,
  actorUserId: string | null,
) {
  const current = await stampOrThrow(fastify, tenantId, employeeId, stampId);
  // Certificările ei rămân fără ștampilă (FK onDelete: SetNull).
  await fastify.prisma.employeeStamp.delete({ where: { id: stampId } });
  if (current.s3Key) await deleteFile(current.s3Key).catch(() => {});
  await logAudit(fastify, tenantId, actorUserId, "employee", employeeId, "stamp.deleted", { name: current.name });
  invalidateReadiness(tenantId);
  return { deleted: true };
}

/** Imaginea ștampilei: curățată (fundal, tăiere, îndreptare) sau doar cu albul transparent. */
export async function setStampImage(
  fastify: FastifyInstance,
  tenantId: string,
  employeeId: string,
  stampId: string,
  image: Buffer,
  actorUserId: string | null,
  mode: StampImageMode = "clean",
) {
  const current = await stampOrThrow(fastify, tenantId, employeeId, stampId);
  const png = await prepareStampImage(image, mode);
  // Cheie nouă la fiecare încărcare: URL-urile din cache nu arată imaginea veche.
  const key = `${tenantId}/employees/${employeeId}/stamp-${stampId}-${Date.now()}.png`;
  await uploadFile(key, png, "image/png");
  const stamp = await fastify.prisma.employeeStamp.update({ where: { id: stampId }, data: { s3Key: key }, select: stampSelect });
  if (current.s3Key) await deleteFile(current.s3Key).catch(() => {});
  await logAudit(fastify, tenantId, actorUserId, "employee", employeeId, current.s3Key ? "stamp.image_replaced" : "stamp.image_set", undefined, { name: stamp.name });
  invalidateReadiness(tenantId);
  return present(stamp);
}

export async function removeStampImage(
  fastify: FastifyInstance,
  tenantId: string,
  employeeId: string,
  stampId: string,
  actorUserId: string | null,
) {
  const current = await stampOrThrow(fastify, tenantId, employeeId, stampId);
  if (!current.s3Key) return present(current);
  const stamp = await fastify.prisma.employeeStamp.update({ where: { id: stampId }, data: { s3Key: null }, select: stampSelect });
  await deleteFile(current.s3Key).catch(() => {});
  await logAudit(fastify, tenantId, actorUserId, "employee", employeeId, "stamp.image_removed", undefined, { name: stamp.name });
  invalidateReadiness(tenantId);
  return present(stamp);
}
