import { getTenantEntitlements } from "../../lib/entitlements/index.js";
import { createEmployeeFromUser, linkedEmployeeId } from "./employee-link.js";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../../lib/hash.js";
import { randomBytes, createHash } from "node:crypto";
import { env } from "../../config/env.js";
import { sendUserInviteEmail } from "../../lib/email.js";
import type { PaginationQuery } from "../../lib/pagination.js";
import { paginationArgs, paginationMeta } from "../../lib/pagination.js";
import type { CreateUserInput, UpdateUserInput } from "./users.schema.js";
import { clearMobileDeviceRevoked, markMobileDeviceRevoked, markUserRevoked } from "../../lib/mobile-devices.js";
import { lockTenant } from "../../lib/tenant-lock.js";

/** Columns the user list may be sorted by (allowlist for `sortBy`). */
export const USERS_SORTABLE = [
  "email",
  "firstName",
  "lastName",
  "role",
  "createdAt",
  "updatedAt",
] as const;

const userSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  isActive: true,
  mobileAccess: true,
  invitePending: true,
  invitedAt: true,
  createdAt: true,
  updatedAt: true,
  employee: { select: { id: true, firstName: true, lastName: true } },
};

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Emite un link de setare a parolei (același mecanism ca resetarea: token aleator,
 * stocat hash-uit, de unică folosință) și trimite e-mailul de invitație.
 * Întoarce `false` dacă SMTP nu e configurat — contul există, dar adminul trebuie
 * să îi comunice altfel parola (sau să retrimită invitația după configurare).
 */
export async function sendInvite(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string,
  invitedByUserId: string,
): Promise<boolean> {
  const [user, tenant, inviter] = await Promise.all([
    fastify.prisma.user.findFirst({ where: { id: userId, tenantId }, select: { id: true, email: true, firstName: true, mobileAccess: true, isActive: true } }),
    fastify.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    fastify.prisma.user.findUnique({ where: { id: invitedByUserId }, select: { firstName: true, lastName: true } }),
  ]);
  if (!user || !user.isActive) throw fastify.httpErrors.notFound("User not found");
  await fastify.prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } });
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  await fastify.prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
  });
  await fastify.prisma.user.update({ where: { id: user.id }, data: { invitePending: true, invitedAt: new Date() } });
  return sendUserInviteEmail({
    to: user.email,
    firstName: user.firstName,
    tenantName: tenant?.name ?? "Operio",
    invitedBy: inviter ? `${inviter.firstName} ${inviter.lastName}`.trim() : "Administratorul firmei",
    setPasswordUrl: `${env.FRONTEND_URL}/reset-password?token=${rawToken}&invite=1`,
    mobileAccess: user.mobileAccess,
  });
}

const deviceSelect = {
  id: true,
  deviceId: true,
  platform: true,
  model: true,
  name: true,
  appVersion: true,
  status: true,
  firstSeenAt: true,
  lastSeenAt: true,
  revokedAt: true,
  revokedBy: { select: { id: true, firstName: true, lastName: true } },
};

/** Phones that logged into the mobile app with this account, newest activity first. */
export async function listDevices(fastify: FastifyInstance, tenantId: string, userId: string) {
  await getById(fastify, tenantId, userId);
  return fastify.prisma.mobileDevice.findMany({
    where: { tenantId, userId },
    select: deviceSelect,
    orderBy: { lastSeenAt: "desc" },
    take: 200,
  });
}

/**
 * Revoke a phone: it can't refresh its session any more, and the Redis
 * denylist cuts its current access token off immediately. Mobile refresh
 * tokens bound to the device are deleted so nothing lingers.
 */
export async function revokeDevice(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string,
  deviceRowId: string,
  revokedById: string,
) {
  const device = await fastify.prisma.mobileDevice.findFirst({ where: { id: deviceRowId, tenantId, userId } });
  if (!device) throw fastify.httpErrors.notFound("Dispozitivul nu a fost găsit");
  const updated = await fastify.prisma.mobileDevice.update({
    where: { id: device.id },
    data: { status: "revoked", revokedAt: new Date(), revokedById },
    select: deviceSelect,
  });
  await fastify.prisma.refreshToken.deleteMany({ where: { userId, client: "mobile", deviceId: device.deviceId } });
  await markMobileDeviceRevoked(userId, device.deviceId);
  return updated;
}

/** Re-allow a previously revoked phone (next login from it works again). */
export async function restoreDevice(fastify: FastifyInstance, tenantId: string, userId: string, deviceRowId: string) {
  const device = await fastify.prisma.mobileDevice.findFirst({ where: { id: deviceRowId, tenantId, userId } });
  if (!device) throw fastify.httpErrors.notFound("Dispozitivul nu a fost găsit");
  await clearMobileDeviceRevoked(userId, device.deviceId);
  return fastify.prisma.mobileDevice.update({
    where: { id: device.id },
    data: { status: "active", revokedAt: null, revokedById: null },
    select: deviceSelect,
  });
}

export async function list(
  fastify: FastifyInstance,
  tenantId: string,
  query: PaginationQuery
) {
  const where = {
    tenantId,
    ...(query.search && {
      OR: [
        { firstName: { contains: query.search, mode: "insensitive" as const } },
        { lastName: { contains: query.search, mode: "insensitive" as const } },
        { email: { contains: query.search, mode: "insensitive" as const } },
      ],
    }),
  };

  const [data, total] = await Promise.all([
    fastify.prisma.user.findMany({
      where,
      select: userSelect,
      ...paginationArgs(query, USERS_SORTABLE),
    }),
    fastify.prisma.user.count({ where }),
  ]);

  return { data, ...paginationMeta(total, query) };
}

export async function getById(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const user = await fastify.prisma.user.findFirst({
    where: { id, tenantId },
    select: userSelect,
  });
  if (!user) throw fastify.httpErrors.notFound("User not found");
  return user;
}

export async function create(
  fastify: FastifyInstance,
  tenantId: string,
  input: CreateUserInput,
  createdByUserId?: string,
) {
  // `User.email` is globally unique (not per tenant), and compared without case
  // so "Ion@x.ro" can't become a second account for "ion@x.ro". The message tells
  // the admin what to do; it says the address has an account, never which firm.
  // (Public registration stays generic — this route needs an authenticated ADMIN.)
  const existing = await fastify.prisma.user.findFirst({
    where: { email: { equals: input.email, mode: "insensitive" } },
    select: { tenantId: true },
  });
  if (existing) {
    throw fastify.httpErrors.conflict(
      existing.tenantId === tenantId
        ? "Această adresă de e-mail e deja în echipa ta — caut-o în lista de utilizatori (poate e dezactivată)."
        : "Această adresă de e-mail are deja un cont Operio. Folosește altă adresă pentru utilizatorul nou."
    );
  }

  // Fără parolă: hash aleator (contul nu poate fi folosit până nu-și setează
  // parola din invitație).
  const invite = !input.password;
  const passwordHash = await hashPassword(input.password ?? randomBytes(48).toString("base64url"));
  const user = await fastify.prisma.user.create({
    data: {
      tenantId,
      email: input.email,
      passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      role: input.role,
      invitePending: invite,
      invitedAt: invite ? new Date() : null,
    },
    select: userSelect,
  });
  let inviteSent = false;
  if (invite) {
    try {
      inviteSent = await sendInvite(fastify, tenantId, user.id, createdByUserId ?? user.id);
    } catch (err) {
      console.error("[users] invite e-mail failed:", err);
    }
  }
  return { ...user, inviteSent };
}

export async function update(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
  input: UpdateUserInput,
  actorUserId: string | null = null
) {
  await getById(fastify, tenantId, id);
  const { employeeId, createEmployee, ...userFields } = input;

  // Legătura cu persoana din echipă trăiește pe Employee, deci se scrie separat —
  // în aceeași tranzacție, ca un cont să nu rămână legat de doi angajați.
  if (employeeId !== undefined) {
    await fastify.prisma.$transaction(async (tx) => {
      if (employeeId !== null) {
        // Tenantul se verifică aici: FK-ul nu poate lega cheia compusă, deci
        // fără această citire un admin ar putea lega un angajat din alt tenant.
        const employee = await tx.employee.findFirst({
          where: { id: employeeId, tenantId },
          select: { id: true, userId: true },
        });
        if (!employee) throw fastify.httpErrors.notFound("Angajatul nu a fost găsit");
        if (employee.userId && employee.userId !== id) {
          throw fastify.httpErrors.conflict("Angajatul este deja legat de alt cont");
        }
      }
      await tx.employee.updateMany({ where: { tenantId, userId: id }, data: { userId: null } });
      if (employeeId !== null) {
        await tx.employee.update({ where: { id: employeeId }, data: { userId: id } });
      }
    });
  }

  if (Object.keys(userFields).length === 0) {
    return getById(fastify, tenantId, id);
  }
  // Switching mobile access off ends the phone sessions: refresh is refused and
  // the access tokens still in flight expire within JWT_ACCESS_EXPIRY.
  if (userFields.mobileAccess === false) {
    await fastify.prisma.refreshToken.deleteMany({ where: { userId: id, client: "mobile" } });
  }
  // Locurile de tehnician ale abonamentului = utilizatorii cu acces mobil.
  // Numărarea și scrierea stau în aceeași tranzacție, sub blocajul tenantului:
  // două activări simultane nu pot trece amândouă de limită.
  if (userFields.mobileAccess === true) {
    const ent = await getTenantEntitlements(fastify.prisma, tenantId);
    if (!ent.has("field.mobile")) {
      throw Object.assign(new Error("Aplicația mobilă nu este inclusă în abonament"), { statusCode: 402, feature: "field.mobile", upgradeTo: "execution" });
    }
    return fastify.prisma.$transaction(async (tx) => {
      await lockTenant(tx, tenantId);
      const used = await tx.user.count({ where: { tenantId, mobileAccess: true, isActive: true, id: { not: id } } });
      if (used >= ent.limits.technicianSeats) {
        throw Object.assign(
          new Error(`Planul ${ent.planLabel} include ${ent.limits.technicianSeats} tehnicieni cu acces mobil — dezactivează un tehnician sau extinde abonamentul`),
          { statusCode: 402, feature: "field.mobile", upgradeTo: "execution" },
        );
      }
      // Accesul mobil cere o persoană din echipă: pe ea se repartizează vizitele din teren.
      // `employeeId` din același PATCH a fost deja legat mai sus; altfel creăm angajatul din cont.
      if (!(await linkedEmployeeId(tx, tenantId, id))) {
        if (!createEmployee) {
          throw fastify.httpErrors.badRequest("Alege un angajat pentru acces mobil sau creează unul din acest cont");
        }
        const account = await tx.user.findUniqueOrThrow({ where: { id }, select: { id: true, firstName: true, lastName: true, email: true } });
        await createEmployeeFromUser(tx, tenantId, account, actorUserId);
      }
      return tx.user.update({ where: { id }, data: userFields, select: userSelect });
    });
  }
  const updated = await fastify.prisma.user.update({
    where: { id },
    data: userFields,
    select: userSelect,
  });
  // Dezactivarea contului taie și sesiunile web în curs (token-urile de acces încă valide).
  if (userFields.isActive === false) {
    await fastify.prisma.refreshToken.deleteMany({ where: { userId: id } });
    await markUserRevoked(id);
  }
  return updated;
}

export async function remove(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  await getById(fastify, tenantId, id);
  const removed = await fastify.prisma.user.update({
    where: { id },
    data: { isActive: false },
    select: userSelect,
  });
  // Nicio sesiune nu supraviețuiește eliminării: refresh-urile cad, iar token-urile
  // de acces încă valide sunt refuzate prin lista de revocare (vezi plugins/auth).
  await fastify.prisma.refreshToken.deleteMany({ where: { userId: id } });
  await markUserRevoked(id);
  return removed;
}
