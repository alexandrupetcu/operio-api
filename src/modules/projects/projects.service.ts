import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import type { PaginationQuery } from "../../lib/pagination.js";
import { paginationArgs, paginationMeta } from "../../lib/pagination.js";
import type {
  CreateProjectInput,
  UpdateProjectInput,
} from "./projects.schema.js";

export async function list(
  fastify: FastifyInstance,
  tenantId: string,
  query: PaginationQuery & { status?: string; type?: string }
) {
  const where = {
    tenantId,
    ...(query.status && { status: query.status as any }),
    ...(query.type && { type: query.type as any }),
    ...(query.search && {
      OR: [
        { name: { contains: query.search, mode: "insensitive" as const } },
        { address: { contains: query.search, mode: "insensitive" as const } },
        {
          client: {
            companyName: { contains: query.search, mode: "insensitive" as const },
          },
        },
        {
          client: {
            firstName: { contains: query.search, mode: "insensitive" as const },
          },
        },
        {
          client: {
            lastName: { contains: query.search, mode: "insensitive" as const },
          },
        },
      ],
    }),
  };

  const [data, total] = await Promise.all([
    fastify.prisma.project.findMany({
      where,
      include: { client: { select: { id: true, type: true, companyName: true, firstName: true, lastName: true } } },
      ...paginationArgs(query),
    }),
    fastify.prisma.project.count({ where }),
  ]);

  return { data, ...paginationMeta(total, query) };
}

export async function getById(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const project = await fastify.prisma.project.findFirst({
    where: { id, tenantId },
    include: {
      client: true,
      documents: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!project) throw fastify.httpErrors.notFound("Project not found");
  return project;
}

export async function create(
  fastify: FastifyInstance,
  tenantId: string,
  input: CreateProjectInput
) {
  // Verify client belongs to this tenant
  const client = await fastify.prisma.client.findFirst({
    where: { id: input.clientId, tenantId },
  });
  if (!client) throw fastify.httpErrors.notFound("Client not found");

  return fastify.prisma.project.create({
    data: {
      tenantId,
      ...input,
      metadata: input.metadata as Prisma.InputJsonValue | undefined,
    },
    include: { client: { select: { id: true, type: true, companyName: true, firstName: true, lastName: true } } },
  });
}

export async function update(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
  input: UpdateProjectInput
) {
  await getById(fastify, tenantId, id);
  return fastify.prisma.project.update({
    where: { id },
    data: {
      ...input,
      metadata: input.metadata as Prisma.InputJsonValue | undefined,
    },
    include: { client: { select: { id: true, type: true, companyName: true, firstName: true, lastName: true } } },
  });
}

export async function remove(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  await getById(fastify, tenantId, id);
  return fastify.prisma.project.delete({ where: { id } });
}
