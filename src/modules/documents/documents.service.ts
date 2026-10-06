import type { FastifyInstance } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { Prisma } from "@prisma/client";
import { Queue } from "bullmq";
import { redisConnection } from "../../config/redis.js";
import { uploadFile, getPresignedUrl, deleteFile } from "../../lib/s3.js";
import { safeS3Filename } from "../../lib/safe-filename.js";

const documentQueue = new Queue("document-generation", {
  connection: redisConnection,
});

const documentInclude = {
  template: { include: { category: true } },
};

// === Project documents ===

export async function listByProject(
  fastify: FastifyInstance,
  tenantId: string,
  projectId: string
) {
  const project = await fastify.prisma.project.findFirst({
    where: { id: projectId, tenantId },
  });
  if (!project) throw fastify.httpErrors.notFound("Project not found");

  return fastify.prisma.document.findMany({
    where: { tenantId, projects: { some: { projectId } } },
    include: documentInclude,
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
      ...documentInclude,
      projects: { include: { project: { select: { id: true, name: true } } } },
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
          templateId: template.id,
          generatedById: userId,
          name: template.name,
          status: "PENDING",
          projects: {
            create: { projectId },
          },
        },
      })
    )
  );

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
  category: string,
  userId: string
) {
  const templates = await fastify.prisma.documentTemplate.findMany({
    where: {
      categoryCode: category,
      OR: [{ tenantId }, { tenantId: null }],
      isActive: true,
      parentGroupId: null, // only top-level (a group renders as one ZIP document)
    },
    orderBy: { sortOrder: "asc" },
  });

  // Keep groups as a single template id — the worker renders a group into ONE
  // ZIP document (bundling its members), instead of one document per member.
  const templateIds = templates.map((t) => t.id);

  if (templateIds.length === 0) {
    throw fastify.httpErrors.badRequest(
      "No templates found for this category"
    );
  }

  return generate(fastify, tenantId, projectId, templateIds, userId);
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
  // Sanitize the user-supplied filename before embedding in the S3 key.
  // Original filename is preserved in the DB row (Document.name) for display.
  const s3Key = `${tenantId}/projects/${projectId}/uploads/${Date.now()}-${safeS3Filename(file.filename)}`;
  await uploadFile(s3Key, buffer, file.mimetype);

  return fastify.prisma.document.create({
    data: {
      tenantId,
      generatedById: userId,
      name: file.filename,
      s3Key,
      status: "UPLOADED",
      projects: {
        create: { projectId },
      },
    },
  });
}

// === Client documents ===

export async function listByClient(
  fastify: FastifyInstance,
  tenantId: string,
  clientId: string
) {
  const client = await fastify.prisma.client.findFirst({
    where: { id: clientId, tenantId },
  });
  if (!client) throw fastify.httpErrors.notFound("Client not found");

  return fastify.prisma.document.findMany({
    where: { tenantId, clients: { some: { clientId } } },
    include: documentInclude,
    orderBy: { createdAt: "desc" },
  });
}

export async function generateForClient(
  fastify: FastifyInstance,
  tenantId: string,
  clientId: string,
  templateIds: string[],
  userId: string,
  context?: Record<string, unknown>
) {
  const client = await fastify.prisma.client.findFirst({
    where: { id: clientId, tenantId },
  });
  if (!client) throw fastify.httpErrors.notFound("Client not found");

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
          templateId: template.id,
          generatedById: userId,
          name: template.name,
          status: "PENDING",
          contextJson: (context ?? undefined) as Prisma.InputJsonValue | undefined,
          clients: {
            create: { clientId },
          },
        },
      })
    )
  );

  await Promise.all(
    documents.map((doc) =>
      documentQueue.add("generate", {
        documentId: doc.id,
        tenantId,
        clientId,
        templateId: doc.templateId,
        context: context ?? undefined,
      })
    )
  );

  return documents;
}

// === Common ===

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

  // Download with a friendly name + the stored file's extension (e.g. a group
  // ZIP saves as "<name>.zip" rather than "<cuid>.zip").
  const ext = doc.s3Key.includes(".") ? doc.s3Key.split(".").pop()! : "";
  const base = doc.name.replace(/\.[a-z0-9]+$/i, "");
  const filename = ext ? `${base}.${ext}` : doc.name;
  const url = await getPresignedUrl(doc.s3Key, 3600, filename);
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
