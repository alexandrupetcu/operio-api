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
  return fastify.prisma.user.update({
    where: { id },
    data: input,
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
