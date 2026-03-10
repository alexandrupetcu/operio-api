import type { FastifyInstance } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { Queue } from "bullmq";
import { redisConnection } from "../../config/redis.js";
import { uploadFile, getPresignedUrl, deleteFile } from "../../lib/s3.js";
import type { DocumentCategory } from "@prisma/client";

const documentQueue = new Queue("document-generation", {
  connection: redisConnection,
});

export async function listByProject(
  fastify: FastifyInstance,
  tenantId: string,
  projectId: string
) {
  // Verify project belongs to tenant
  const project = await fastify.prisma.project.findFirst({
    where: { id: projectId, tenantId },
  });
  if (!project) throw fastify.httpErrors.notFound("Project not found");

  return fastify.prisma.document.findMany({
    where: { projectId, tenantId },
    include: { template: { select: { id: true, name: true, category: true } } },
    orderBy: { createdAt: "desc" },
  });
}

export async function getById(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const doc = await fastify.prisma.document.findFirst({
    where: { id, tenantId },
    include: {
      template: { select: { id: true, name: true, category: true } },
      project: { select: { id: true, name: true } },
      generatedBy: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  if (!doc) throw fastify.httpErrors.notFound("Document not found");
  return doc;
}

export async function generate(
  fastify: FastifyInstance,
  tenantId: string,
  projectId: string,
  templateIds: string[],
  userId: string
) {
  const project = await fastify.prisma.project.findFirst({
    where: { id: projectId, tenantId },
  });
  if (!project) throw fastify.httpErrors.notFound("Project not found");

  const templates = await fastify.prisma.documentTemplate.findMany({
    where: {
      id: { in: templateIds },
      OR: [{ tenantId }, { tenantId: null }],
      isActive: true,
    },
  });

  if (templates.length === 0) {
    throw fastify.httpErrors.badRequest("No valid templates found");
  }

  const documents = await Promise.all(
    templates.map((template) =>
      fastify.prisma.document.create({
        data: {
          tenantId,
          projectId,
          templateId: template.id,
          generatedById: userId,
          name: template.name,
          status: "PENDING",
        },
      })
    )
  );

  // Queue jobs
  await Promise.all(
    documents.map((doc) =>
      documentQueue.add("generate", {
        documentId: doc.id,
        tenantId,
        projectId,
        templateId: doc.templateId,
      })
    )
  );

  return documents;
}

export async function generateBatch(
  fastify: FastifyInstance,
  tenantId: string,
  projectId: string,
  category: DocumentCategory,
  userId: string
) {
  const templates = await fastify.prisma.documentTemplate.findMany({
    where: {
      category,
      OR: [{ tenantId }, { tenantId: null }],
      isActive: true,
    },
    orderBy: { sortOrder: "asc" },
  });

  if (templates.length === 0) {
    throw fastify.httpErrors.badRequest(
      "No templates found for this category"
    );
  }

  return generate(
    fastify,
    tenantId,
    projectId,
    templates.map((t) => t.id),
    userId
  );
}

export async function upload(
  fastify: FastifyInstance,
  tenantId: string,
  projectId: string,
  file: MultipartFile,
  userId: string
) {
  const project = await fastify.prisma.project.findFirst({
    where: { id: projectId, tenantId },
  });
  if (!project) throw fastify.httpErrors.notFound("Project not found");

  const buffer = await file.toBuffer();
  const s3Key = `${tenantId}/projects/${projectId}/uploads/${Date.now()}-${file.filename}`;
  await uploadFile(s3Key, buffer, file.mimetype);

  return fastify.prisma.document.create({
    data: {
      tenantId,
      projectId,
      generatedById: userId,
      name: file.filename,
      s3Key,
      status: "UPLOADED",
    },
  });
}

export async function getDownloadUrl(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const doc = await fastify.prisma.document.findFirst({
    where: { id, tenantId },
  });
  if (!doc) throw fastify.httpErrors.notFound("Document not found");
  if (!doc.s3Key) {
    throw fastify.httpErrors.badRequest("Document has not been generated yet");
  }

  const url = await getPresignedUrl(doc.s3Key);
  return { url, name: doc.name };
}

export async function remove(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const doc = await fastify.prisma.document.findFirst({
    where: { id, tenantId },
  });
  if (!doc) throw fastify.httpErrors.notFound("Document not found");

  if (doc.s3Key) {
    await deleteFile(doc.s3Key);
  }
  return fastify.prisma.document.delete({ where: { id } });
}
