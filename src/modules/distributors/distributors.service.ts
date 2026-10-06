import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import type {
  CreateDistributorInput,
  UpdateDistributorInput,
} from "./distributors.schema.js";

export async function list(
  fastify: FastifyInstance,
  tenantId: string,
  activeOnly?: boolean
) {
  return fastify.prisma.distributor.findMany({
    where: {
      tenantId,
      ...(activeOnly !== undefined && { isActive: activeOnly }),
    },
    orderBy: { name: "asc" },
  });
}

export async function getById(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const d = await fastify.prisma.distributor.findFirst({
    where: { id, tenantId },
    include: {
      _count: { select: { projects: true, workflowDefinitions: true } },
    },
  });
  if (!d) throw fastify.httpErrors.notFound("Distributor not found");
  return d;
}

export async function create(
  fastify: FastifyInstance,
  tenantId: string,
  input: CreateDistributorInput
) {
  const existing = await fastify.prisma.distributor.findUnique({
    where: { tenantId_code: { tenantId, code: input.code } },
  });
  if (existing) {
    throw fastify.httpErrors.conflict(
      `Distributor with code '${input.code}' already exists`
    );
  }

  return fastify.prisma.distributor.create({
    data: {
      tenantId,
      code: input.code,
      name: input.name,
      contactJson: input.contactJson as Prisma.InputJsonValue | undefined,
      isActive: input.isActive ?? true,
    },
  });
}

export async function update(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
  input: UpdateDistributorInput
) {
  await getById(fastify, tenantId, id);

  return fastify.prisma.distributor.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.contactJson !== undefined && {
        contactJson: input.contactJson as Prisma.InputJsonValue,
      }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    },
  });
}

export async function remove(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const d = await fastify.prisma.distributor.findFirst({
    where: { id, tenantId },
    include: { _count: { select: { projects: true } } },
  });
  if (!d) throw fastify.httpErrors.notFound("Distributor not found");
  if (d._count.projects > 0) {
    throw fastify.httpErrors.conflict(
      "Cannot delete distributor with existing projects"
    );
  }

  return fastify.prisma.distributor.delete({ where: { id } });
}
