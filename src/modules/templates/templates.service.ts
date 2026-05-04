import type { FastifyInstance } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { uploadFile, deleteFile, getPresignedUrl } from "../../lib/s3.js";
import type { CreateTemplateInput, UpdateTemplateInput } from "./templates.schema.js";

export async function list(
  fastify: FastifyInstance,
  tenantId: string,
  opts: { category?: string; search?: string; page?: number; limit?: number }
) {
  const { category, search, page = 1, limit = 10 } = opts;
  const skip = (page - 1) * limit;

  const where = {
    OR: [{ tenantId }, { tenantId: null }],
    ...(category && { categoryCode: category }),
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
      include: { category: true },
      orderBy: [{ categoryCode: "asc" }, { sortOrder: "asc" }, { createdAt: "desc" }],
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
    include: { category: true },
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
      categoryCode: input.category,
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
  category: string
) {
  const buffer = await file.toBuffer();
  const s3Key = `templates/${tenantId}/${Date.now()}-${file.filename}`;
  await uploadFile(s3Key, buffer, file.mimetype);

  return fastify.prisma.documentTemplate.create({
    data: { tenantId, name, categoryCode: category, s3Key },
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

  const { category, ...rest } = input;
  return fastify.prisma.documentTemplate.update({
    where: { id },
    data: {
      ...rest,
      ...(category && { categoryCode: category }),
    },
  });
}

export async function remove(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const template = await fastify.prisma.documentTemplate.findFirst({
    where: { id, OR: [{ tenantId }, { tenantId: null }] },
  });
  if (!template)
    throw fastify.httpErrors.notFound("Template not found");

  return fastify.prisma.documentTemplate.delete({ where: { id } });
}

export async function bulkRemove(
  fastify: FastifyInstance,
  tenantId: string,
  ids: string[]
) {
  const result = await fastify.prisma.documentTemplate.deleteMany({
    where: {
      id: { in: ids },
      OR: [{ tenantId }, { tenantId: null }],
    },
  });
  return { deleted: result.count };
}

// ── Admin-only functions ──────────────────────────────────────────────

export async function listAdmin(
  fastify: FastifyInstance,
  opts: {
    category?: string;
    search?: string;
    scope?: "all" | "system" | "tenant";
    page?: number;
    limit?: number;
  }
) {
  const { category, search, scope = "all", page = 1, limit = 10 } = opts;
  const skip = (page - 1) * limit;

  const where = {
    ...(scope === "system" && { tenantId: null }),
    ...(scope === "tenant" && { tenantId: { not: null } }),
    ...(category && { categoryCode: category }),
    ...(search && {
      OR: [
        { name: { contains: search, mode: "insensitive" as const } },
        { description: { contains: search, mode: "insensitive" as const } },
      ],
    }),
  };

  const [data, total] = await Promise.all([
    fastify.prisma.documentTemplate.findMany({
      where,
      include: { category: true },
      orderBy: [{ categoryCode: "asc" }, { sortOrder: "asc" }, { createdAt: "desc" }],
      skip,
      take: limit,
    }),
    fastify.prisma.documentTemplate.count({ where }),
  ]);

  return { data, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getDownloadUrl(
  fastify: FastifyInstance,
  id: string
) {
  const template = await fastify.prisma.documentTemplate.findUnique({
    where: { id },
  });
  if (!template) throw fastify.httpErrors.notFound("Template not found");
  if (!template.s3Key)
    throw fastify.httpErrors.badRequest("Template has no file to download");

  const url = await getPresignedUrl(template.s3Key, 3600);
  return { url, filename: template.name };
}

export async function replaceFile(
  fastify: FastifyInstance,
  id: string,
  file: MultipartFile
) {
  const template = await fastify.prisma.documentTemplate.findUnique({
    where: { id },
  });
  if (!template) throw fastify.httpErrors.notFound("Template not found");
  if (!template.s3Key)
    throw fastify.httpErrors.badRequest("Template is not a file-based template");

  // Delete old file (best-effort)
  try {
    await deleteFile(template.s3Key);
  } catch (err) {
    fastify.log.warn({ err, s3Key: template.s3Key }, "Failed to delete old template file");
  }

  // Upload new file
  const buffer = await file.toBuffer();
  const tenantId = template.tenantId ?? "system";
  const newS3Key = `templates/${tenantId}/${Date.now()}-${file.filename}`;
  await uploadFile(newS3Key, buffer, file.mimetype);

  return fastify.prisma.documentTemplate.update({
    where: { id },
    data: { s3Key: newS3Key },
  });
}
