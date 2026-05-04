import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import type { CreateProjectTypeInput, UpdateProjectTypeInput } from "./project-types.schema.js";

export async function list(
  fastify: FastifyInstance,
  tenantId: string,
  activeOnly?: boolean
) {
  return fastify.prisma.projectType.findMany({
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
  const pt = await fastify.prisma.projectType.findFirst({
    where: { id, tenantId },
    include: {
      _count: { select: { projects: true, workflowDefinitions: true } },
    },
  });
  if (!pt) throw fastify.httpErrors.notFound("Project type not found");
  return pt;
}

export async function create(
  fastify: FastifyInstance,
  tenantId: string,
  input: CreateProjectTypeInput
) {
  const existing = await fastify.prisma.projectType.findUnique({
    where: { tenantId_code: { tenantId, code: input.code } },
  });
  if (existing) {
    throw fastify.httpErrors.conflict(`Project type with code '${input.code}' already exists`);
  }

  return fastify.prisma.projectType.create({
    data: {
      tenantId,
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      isActive: input.isActive ?? true,
      metadataJson: input.metadataJson as Prisma.InputJsonValue | undefined,
    },
  });
}

export async function update(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
  input: UpdateProjectTypeInput
) {
  await getById(fastify, tenantId, id);

  return fastify.prisma.projectType.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      ...(input.metadataJson !== undefined && {
        metadataJson: input.metadataJson as Prisma.InputJsonValue,
      }),
    },
  });
}

export async function remove(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const pt = await fastify.prisma.projectType.findFirst({
    where: { id, tenantId },
    include: { _count: { select: { projects: true } } },
  });
  if (!pt) throw fastify.httpErrors.notFound("Project type not found");
  if (pt._count.projects > 0) {
    throw fastify.httpErrors.conflict("Cannot delete project type with existing projects");
  }

  return fastify.prisma.projectType.delete({ where: { id } });
}
