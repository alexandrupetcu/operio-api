import type { FastifyInstance } from "fastify";
import { invalidateEmployeeLink } from "../../lib/employee-link-cache.js";
import type { Prisma, PrismaClient } from "@prisma/client";
import { logAudit } from "../../lib/audit.js";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Programările se repartizează unui Employee, nu unui User. Un cont cu acces mobil
 * fără persoană legată și-ar vedea vizitele din teren „nerepartizate” — așa că
 * legătura se face obligatoriu când se acordă accesul (admin alege un angajat sau
 * îl creăm din cont), iar conturile care au deja acces o primesc la primul login
 * din telefon.
 */
export async function createEmployeeFromUser(
  db: Db,
  tenantId: string,
  user: { id: string; firstName: string; lastName: string; email: string },
  actorUserId: string | null,
) {
  const employee = await db.employee.create({
    data: {
      tenantId,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      position: "instalator",
      userId: user.id,
    },
    select: { id: true },
  });
  await logAudit(db as PrismaClient, tenantId, actorUserId, "employee", employee.id, "auto_link", null, { userId: user.id });
  invalidateEmployeeLink(tenantId, user.id);
  return employee;
}

/** Contul are deja o persoană din echipă legată? */
export async function linkedEmployeeId(db: Db, tenantId: string, userId: string): Promise<string | null> {
  const row = await db.employee.findFirst({ where: { tenantId, userId }, select: { id: true } });
  return row?.id ?? null;
}

/**
 * Plasa pentru conturile care au primit acces mobil înainte de regula de mai sus:
 * la login-ul din telefon, un cont nelegat primește un angajat creat din numele
 * contului. Idempotent — un al doilea login nu creează încă unul.
 */
export async function ensureEmployeeForMobileUser(
  fastify: FastifyInstance,
  user: { id: string; tenantId: string },
): Promise<string> {
  const existing = await linkedEmployeeId(fastify.prisma, user.tenantId, user.id);
  if (existing) return existing;
  const account = await fastify.prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  const created = await createEmployeeFromUser(fastify.prisma, user.tenantId, account, user.id);
  return created.id;
}
