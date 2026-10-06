import type { FastifyInstance } from "fastify";
import type { PaginationQuery } from "../../lib/pagination.js";
import { paginationArgs, paginationMeta } from "../../lib/pagination.js";
import { uploadFile, deleteFile, getPresignedUrl } from "../../lib/s3.js";
import type { CreateEmployeeInput, UpdateEmployeeInput } from "./employees.routes.js";

const NON_TERMINAL_PROJECT = ["completed", "rejected", "cancelled"];
const ACTIVE_APPT = ["scheduled", "in_progress"];

/** Add a presigned `signatureUrl` (for previewing) next to the stored s3 key. */
async function withSignatureUrl<T extends { signatureS3Key: string | null }>(
  employee: T,
): Promise<T & { signatureUrl: string | null }> {
  return {
    ...employee,
    signatureUrl: employee.signatureS3Key ? await getPresignedUrl(employee.signatureS3Key) : null,
  };
}

function todayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

export async function list(
  fastify: FastifyInstance,
  tenantId: string,
  query: PaginationQuery & { isActive?: boolean; employeeType?: string; onlyUserId?: string }
) {
  const { start, end } = todayRange();
  const where = {
    tenantId,
    ...(query.onlyUserId && { userId: query.onlyUserId }),
    ...(query.isActive !== undefined && { isActive: query.isActive }),
    ...(query.employeeType && { employeeType: query.employeeType }),
    ...(query.search && {
      OR: [
        { firstName: { contains: query.search, mode: "insensitive" as const } },
        { lastName: { contains: query.search, mode: "insensitive" as const } },
        { position: { contains: query.search, mode: "insensitive" as const } },
        { email: { contains: query.search, mode: "insensitive" as const } },
        { phone: { contains: query.search, mode: "insensitive" as const } },
      ],
    }),
  };

  const [data, total] = await Promise.all([
    fastify.prisma.employee.findMany({
      where,
      include: {
        // Contul legat, ca selectorul din Setări să nu ofere un angajat deja legat.
        user: { select: { id: true, email: true } },
        // activeProjects + whether they have an active appointment today (on-site).
        _count: {
          select: {
            projects: { where: { status: { notIn: NON_TERMINAL_PROJECT } } },
            appointments: {
              where: { date: { gte: start, lte: end }, status: { in: ACTIVE_APPT }, deletedAt: null },
            },
          },
        },
      },
      ...paginationArgs(query),
      orderBy: { lastName: "asc" },
    }),
    fastify.prisma.employee.count({ where }),
  ]);

  return {
    data: await Promise.all(data.map(withSignatureUrl)),
    ...paginationMeta(total, query),
  };
}

/** KPI counts for the Angajați page header. */
export async function stats(fastify: FastifyInstance, tenantId: string) {
  const { start, end } = todayRange();
  const [total, intern, colaborator, active, emps, onSiteRows] = await Promise.all([
    fastify.prisma.employee.count({ where: { tenantId } }),
    fastify.prisma.employee.count({ where: { tenantId, employeeType: "intern" } }),
    fastify.prisma.employee.count({ where: { tenantId, employeeType: "colaborator" } }),
    fastify.prisma.employee.count({ where: { tenantId, isActive: true } }),
    fastify.prisma.employee.findMany({ where: { tenantId }, select: { credentials: true } }),
    fastify.prisma.appointment.findMany({
      where: {
        tenantId,
        date: { gte: start, lte: end },
        status: { in: ACTIVE_APPT },
        deletedAt: null,
        employeeId: { not: null },
      },
      select: { employeeId: true },
      distinct: ["employeeId"],
    }),
  ]);

  const authorizations = emps.reduce((sum, e) => {
    const creds = (e.credentials ?? {}) as Record<string, unknown>;
    return sum + Object.values(creds).filter((v) => typeof v === "string" && v.trim()).length;
  }, 0);
  const onSite = onSiteRows.length;

  return { total, intern, colaborator, authorizations, onSite, available: Math.max(0, active - onSite) };
}

export async function getById(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const employee = await fastify.prisma.employee.findFirst({
    where: { id, tenantId },
  });
  if (!employee) throw fastify.httpErrors.notFound("Employee not found");
  return withSignatureUrl(employee);
}

export async function create(
  fastify: FastifyInstance,
  tenantId: string,
  input: CreateEmployeeInput
) {
  return fastify.prisma.employee.create({
    data: {
      tenantId,
      ...input,
    },
  });
}

export async function update(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
  input: UpdateEmployeeInput
) {
  await getById(fastify, tenantId, id);
  return fastify.prisma.employee.update({
    where: { id },
    data: input,
  });
}

export async function remove(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  await getById(fastify, tenantId, id);
  return fastify.prisma.employee.delete({ where: { id } });
}

/** Store an employee's signature (PNG/JPEG data URL drawn on the canvas) in S3. */
export async function setSignature(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
  dataUrl: string,
) {
  const matches = dataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
  if (!matches) throw fastify.httpErrors.badRequest("Invalid image data URL");

  const existing = await fastify.prisma.employee.findFirst({
    where: { id, tenantId },
    select: { id: true, signatureS3Key: true },
  });
  if (!existing) throw fastify.httpErrors.notFound("Employee not found");

  const buffer = Buffer.from(matches[2], "base64");
  const ext = matches[1] === "jpg" ? "jpeg" : matches[1];
  const s3Key = `${tenantId}/employees/${id}/signature.${ext}`;
  await uploadFile(s3Key, buffer, `image/${ext}`);
  if (existing.signatureS3Key && existing.signatureS3Key !== s3Key) {
    await deleteFile(existing.signatureS3Key).catch(() => {});
  }

  await fastify.prisma.employee.update({
    where: { id },
    data: { signatureS3Key: s3Key },
  });

  return { signatureS3Key: s3Key, signatureUrl: await getPresignedUrl(s3Key) };
}

export async function removeSignature(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
) {
  const existing = await fastify.prisma.employee.findFirst({
    where: { id, tenantId },
    select: { id: true, signatureS3Key: true },
  });
  if (!existing) throw fastify.httpErrors.notFound("Employee not found");

  if (existing.signatureS3Key) {
    await deleteFile(existing.signatureS3Key).catch(() => {});
  }
  await fastify.prisma.employee.update({
    where: { id },
    data: { signatureS3Key: null },
  });
  return { success: true };
}
