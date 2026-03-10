import type { FastifyInstance } from "fastify";
import type { PaginationQuery } from "../../lib/pagination.js";
import { paginationArgs, paginationMeta } from "../../lib/pagination.js";
import type { CreateEmployeeInput, UpdateEmployeeInput } from "./employees.routes.js";

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
        { position: { contains: query.search, mode: "insensitive" as const } },
        { email: { contains: query.search, mode: "insensitive" as const } },
        { phone: { contains: query.search, mode: "insensitive" as const } },
      ],
    }),
  };

  const [data, total] = await Promise.all([
    fastify.prisma.employee.findMany({
      where,
      ...paginationArgs(query),
      orderBy: { lastName: "asc" },
    }),
    fastify.prisma.employee.count({ where }),
  ]);

  return { data, ...paginationMeta(total, query) };
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
  return employee;
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
