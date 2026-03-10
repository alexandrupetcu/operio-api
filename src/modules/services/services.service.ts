import type { FastifyInstance } from "fastify";
import type { PaginationQuery } from "../../lib/pagination.js";
import { paginationArgs, paginationMeta } from "../../lib/pagination.js";
import type { CreateServiceInput, UpdateServiceInput } from "./services.routes.js";

export async function list(
  fastify: FastifyInstance,
  tenantId: string,
  query: PaginationQuery
) {
  const where = {
    tenantId,
    ...(query.search && {
      OR: [
        { name: { contains: query.search, mode: "insensitive" as const } },
        { description: { contains: query.search, mode: "insensitive" as const } },
      ],
    }),
  };

  const [data, total] = await Promise.all([
    fastify.prisma.service.findMany({
      where,
      ...paginationArgs(query),
      orderBy: { name: "asc" },
    }),
    fastify.prisma.service.count({ where }),
  ]);

  return { data, ...paginationMeta(total, query) };
}

export async function getById(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const service = await fastify.prisma.service.findFirst({
    where: { id, tenantId },
  });
  if (!service) throw fastify.httpErrors.notFound("Service not found");
  return service;
}

export async function create(
  fastify: FastifyInstance,
  tenantId: string,
  input: CreateServiceInput
) {
  return fastify.prisma.service.create({
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
  input: UpdateServiceInput
) {
  await getById(fastify, tenantId, id);
  return fastify.prisma.service.update({
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
  return fastify.prisma.service.delete({ where: { id } });
}
