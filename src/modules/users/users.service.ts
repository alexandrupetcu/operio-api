import type { FastifyInstance } from "fastify";
import { hashPassword } from "../../lib/hash.js";
import type { PaginationQuery } from "../../lib/pagination.js";
import { paginationArgs, paginationMeta } from "../../lib/pagination.js";
import type { CreateUserInput, UpdateUserInput } from "./users.schema.js";

const userSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  employee: { select: { id: true, firstName: true, lastName: true } },
};

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
      ...paginationArgs(query),
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
  input: CreateUserInput
) {
  const existing = await fastify.prisma.user.findUnique({
    where: { tenantId_email: { tenantId, email: input.email } },
  });
  if (existing) throw fastify.httpErrors.conflict("Email already in use");

  const passwordHash = await hashPassword(input.password);
  return fastify.prisma.user.create({
    data: {
      tenantId,
      email: input.email,
      passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      role: input.role,
    },
    select: userSelect,
  });
}

export async function update(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
  input: UpdateUserInput
) {
  await getById(fastify, tenantId, id);
  const { employeeId, ...userFields } = input;

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
  return fastify.prisma.user.update({
    where: { id },
    data: userFields,
    select: userSelect,
  });
}

export async function remove(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  await getById(fastify, tenantId, id);
  return fastify.prisma.user.update({
    where: { id },
    data: { isActive: false },
    select: userSelect,
  });
}
