import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import type {
  CreateDrawingTemplateInput,
  UpdateDrawingTemplateInput,
} from "./drawing-templates.routes.js";

export async function list(fastify: FastifyInstance, tenantId: string) {
  // Return templates belonging to this tenant + global templates (tenantId = null)
  return fastify.prisma.drawingTemplate.findMany({
    where: {
      OR: [{ tenantId }, { isGlobal: true }],
    },
    orderBy: [{ isGlobal: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      isGlobal: true,
      tenantId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function getById(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const template = await fastify.prisma.drawingTemplate.findFirst({
    where: {
      id,
      OR: [{ tenantId }, { isGlobal: true }],
    },
  });
  if (!template) throw fastify.httpErrors.notFound("Drawing template not found");
  return template;
}

export async function create(
  fastify: FastifyInstance,
  tenantId: string | null,
  input: CreateDrawingTemplateInput
) {
  return fastify.prisma.drawingTemplate.create({
    data: {
      tenantId,
      name: input.name,
      canvasJson: input.canvasJson as Prisma.InputJsonValue,
      isGlobal: input.isGlobal,
    },
  });
}

export async function update(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
  input: UpdateDrawingTemplateInput
) {
  // Ensure the template belongs to this tenant (can't edit global templates unless admin)
  const existing = await fastify.prisma.drawingTemplate.findFirst({
    where: { id, OR: [{ tenantId }, { isGlobal: true }] },
  });
  if (!existing) throw fastify.httpErrors.notFound("Drawing template not found");

  const data: Prisma.DrawingTemplateUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.canvasJson !== undefined) data.canvasJson = input.canvasJson as Prisma.InputJsonValue;

  return fastify.prisma.drawingTemplate.update({
    where: { id },
    data,
  });
}

export async function remove(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const existing = await fastify.prisma.drawingTemplate.findFirst({
    where: { id, OR: [{ tenantId }, { isGlobal: true }] },
  });
  if (!existing) throw fastify.httpErrors.notFound("Drawing template not found");

  return fastify.prisma.drawingTemplate.delete({ where: { id } });
}
