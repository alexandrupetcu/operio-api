import type { FastifyInstance } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { uploadFile } from "../../lib/s3.js";
import type { CreateTemplateInput, UpdateTemplateInput } from "./templates.schema.js";
import type { DocumentCategory } from "@prisma/client";

export async function list(
  fastify: FastifyInstance,
  tenantId: string,
  opts: { category?: string; search?: string; page?: number; limit?: number }
) {
  const { category, search, page = 1, limit = 10 } = opts;
  const skip = (page - 1) * limit;

  const where = {
    OR: [{ tenantId }, { tenantId: null }],
    ...(category && { category: category as DocumentCategory }),
    ...(search && {
      AND: {
        OR: [
          { name: { contains: search, mode: "insensitive" as const } },
          { description: { contains: search, mode: "insensitive" as const } },
        ],
      },
    }),
  };

  const [data, total] = await Promise.all([
    fastify.prisma.documentTemplate.findMany({
      where,
      orderBy: [{ category: "asc" }, { sortOrder: "asc" }, { createdAt: "desc" }],
      skip,
      take: limit,
    }),
    fastify.prisma.documentTemplate.count({ where }),
  ]);

  return {
    data,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  };
}

export async function getById(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const template = await fastify.prisma.documentTemplate.findFirst({
    where: { id, OR: [{ tenantId }, { tenantId: null }] },
  });
  if (!template) throw fastify.httpErrors.notFound("Template not found");
  return template;
}

export async function create(
  fastify: FastifyInstance,
  tenantId: string,
  input: CreateTemplateInput
) {
  return fastify.prisma.documentTemplate.create({
    data: {
      tenantId,
      category: input.category as DocumentCategory,
      name: input.name,
      description: input.description,
      content: input.content,
    },
  });
}

export async function createFromFile(
  fastify: FastifyInstance,
  tenantId: string,
  file: MultipartFile,
  name: string,
  category: DocumentCategory
) {
  const buffer = await file.toBuffer();
  const s3Key = `templates/${tenantId}/${Date.now()}-${file.filename}`;
  await uploadFile(s3Key, buffer, file.mimetype);

  return fastify.prisma.documentTemplate.create({
    data: { tenantId, name, category, s3Key },
  });
}

export async function update(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
  input: UpdateTemplateInput
) {
  const template = await fastify.prisma.documentTemplate.findFirst({
    where: { id, OR: [{ tenantId }, { tenantId: null }] },
  });
  if (!template) throw fastify.httpErrors.notFound("Template not found");

  return fastify.prisma.documentTemplate.update({
    where: { id },
    data: input,
  });
}

export async function remove(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const template = await fastify.prisma.documentTemplate.findFirst({
    where: { id, tenantId },
  });
  if (!template)
    throw fastify.httpErrors.notFound("Template not found or is a system template");

  return fastify.prisma.documentTemplate.delete({ where: { id } });
}
