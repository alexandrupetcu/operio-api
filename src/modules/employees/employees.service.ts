import type { FastifyInstance } from "fastify";
import type { PaginationQuery } from "../../lib/pagination.js";
import { paginationArgs, paginationMeta } from "../../lib/pagination.js";
import { uploadFile, deleteFile, getPresignedUrl } from "../../lib/s3.js";
import { withPositions } from "./positions.js";
import type { CreateEmployeeInput, UpdateEmployeeInput } from "./employees.routes.js";

/** Columns the employee list may be sorted by (allowlist for `sortBy`). */
export const EMPLOYEES_SORTABLE = ["lastName", "firstName", "createdAt", "updatedAt"] as const;

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
        { positions: { has: query.search.toLowerCase() } },
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
        // Rezumatul certificărilor pentru listă (insigne + expirări).
        certifications: { select: { id: true, type: true, label: true, expiresAt: true }, orderBy: { createdAt: "asc" } },
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
      ...paginationArgs(query, EMPLOYEES_SORTABLE),
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
    fastify.prisma.employeeCertification.count({ where: { tenantId, employee: { isActive: true } } }),
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

  // Certificările angajaților activi (legitimații ANRE, atestate ISCIR…).
  const authorizations = emps;
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
    include: {
      user: { select: { id: true, email: true, mobileAccess: true } },
      _count: {
        select: {
          appointments: {
            where: { date: { gte: todayRange().start, lte: todayRange().end }, status: { in: ACTIVE_APPT }, deletedAt: null },
          },
        },
      },
    },
  });
  if (!employee) throw fastify.httpErrors.notFound("Employee not found");
  return withSignatureUrl(employee);
}

/**
 * Proiectele persoanei (pagina de detaliu): cele alocate direct și cele în care e
 * în echipă (cu rolul din proiect). Fără proiectele ascunse de dosar rapid.
 */
export async function listEmployeeProjects(fastify: FastifyInstance, tenantId: string, id: string) {
  const employee = await fastify.prisma.employee.findFirst({ where: { id, tenantId }, select: { id: true } });
  if (!employee) throw fastify.httpErrors.notFound("Employee not found");
  const projects = await fastify.prisma.project.findMany({
    where: {
      tenantId,
      kind: "project",
      OR: [{ assignedEmployeeId: id }, { teamMembers: { some: { employeeId: id } } }],
    },
    select: {
      id: true,
      name: true,
      status: true,
      address: true,
      city: true,
      scheduledDate: true,
      updatedAt: true,
      teamMembers: { where: { employeeId: id }, select: { role: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  return projects.map(({ teamMembers, ...p }) => ({ ...p, roles: teamMembers.map((t) => t.role) }));
}

/** Jurnalul persoanei (certificări, ștampile, semnătură, date) — cele mai noi întâi. */
export async function listEmployeeActivity(fastify: FastifyInstance, tenantId: string, id: string) {
  const employee = await fastify.prisma.employee.findFirst({ where: { id, tenantId }, select: { id: true } });
  if (!employee) throw fastify.httpErrors.notFound("Employee not found");
  const rows = await fastify.prisma.auditLog.findMany({
    where: { tenantId, entityType: "employee", entityId: id },
    select: {
      id: true,
      action: true,
      beforeJson: true,
      afterJson: true,
      createdAt: true,
      actorUser: { select: { firstName: true, lastName: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return rows.map(({ actorUser, ...r }) => ({
    ...r,
    actorName: actorUser ? `${actorUser.firstName} ${actorUser.lastName}`.trim() : null,
  }));
}

export async function create(
  fastify: FastifyInstance,
  tenantId: string,
  input: CreateEmployeeInput
) {
  return fastify.prisma.employee.create({
    data: {
      tenantId,
      ...withPositions(input),
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
    data: withPositions(input),
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

// Identificatorul aplicației mobile — același în operio-mobile/app.json
// (`android.package` / `ios.bundleIdentifier`). Pagina App Store e un placeholder
// până la publicare.
const ANDROID_PACKAGE = "com.operio.mobile";
export const PLAY_STORE_URL = `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`;
export const APP_STORE_URL = "https://apps.apple.com/app/operio";

/** Număr de telefon RO → cifre pentru wa.me (prefix 40, fără „+”, „00” sau „0” inițial). */
export function whatsappDigits(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0") && digits.length === 10) digits = "40" + digits.slice(1);
  else if (digits.length === 9 && digits.startsWith("7")) digits = "40" + digits;
  return digits.length >= 10 ? digits : null;
}

/**
 * Mesajul de invitație pentru un tehnician (WhatsApp / SMS), cu linkurile către
 * aplicație și e-mailul de autentificare dacă angajatul are deja un cont legat.
 * Nu trimite nimic — operatorul alege canalul.
 */
export async function buildInvite(fastify: FastifyInstance, tenantId: string, id: string) {
  const [employee, tenant] = await Promise.all([
    fastify.prisma.employee.findFirst({
      where: { id, tenantId },
      select: { firstName: true, phone: true, user: { select: { email: true, isActive: true } } },
    }),
    fastify.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } }),
  ]);
  if (!employee) throw fastify.httpErrors.notFound("Employee not found");

  const email = employee.user?.isActive ? employee.user.email : undefined;
  const lines = [
    `Salut, ${employee.firstName}! ${tenant.name} folosește Operio pentru programări și fișele de revizie/verificare.`,
    "Instalează aplicația Operio pe telefon:",
    `Android: ${PLAY_STORE_URL}`,
    `iPhone: ${APP_STORE_URL}`,
    email
      ? `Intri cu e-mailul ${email}; parola o primești separat.`
      : "Datele de autentificare le primești separat, după ce ți se creează contul.",
  ];
  const smsBody = lines.join("\n");
  const digits = whatsappDigits(employee.phone);
  return {
    whatsappUrl: digits ? `https://wa.me/${digits}?text=${encodeURIComponent(smsBody)}` : null,
    smsBody,
    ...(email && { email }),
  };
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
