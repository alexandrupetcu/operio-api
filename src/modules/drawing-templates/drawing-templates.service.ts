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

/**
 * Load a template for mutation. Tenant ADMIN/MANAGER may only touch rows with
 * `tenantId === tenantId`; global rows (`tenantId: null` / `isGlobal`) are
 * MASTER_ADMIN only.
 */
async function findMutable(fastify: FastifyInstance, tenantId: string, role: string, id: string) {
  const existing = await fastify.prisma.drawingTemplate.findFirst({
    where: { id, OR: [{ tenantId }, { isGlobal: true }, { tenantId: null }] },
  });
  if (!existing) throw fastify.httpErrors.notFound("Drawing template not found");
  const isGlobalRow = existing.tenantId === null || existing.isGlobal;
  if (isGlobalRow && role !== "MASTER_ADMIN") {
    throw fastify.httpErrors.forbidden("Doar administratorul platformei poate modifica șabloanele globale");
  }
  if (!isGlobalRow && existing.tenantId !== tenantId) {
    throw fastify.httpErrors.notFound("Drawing template not found");
  }
  return existing;
}

export async function update(
  fastify: FastifyInstance,
  tenantId: string,
  role: string,
  id: string,
  input: UpdateDrawingTemplateInput
) {
  await findMutable(fastify, tenantId, role, id);

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
  role: string,
  id: string
) {
  await findMutable(fastify, tenantId, role, id);
  return fastify.prisma.drawingTemplate.delete({ where: { id } });
}
