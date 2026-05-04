import type { FastifyInstance } from "fastify";
import { Queue } from "bullmq";
import { redisConnection } from "../../config/redis.js";

const docQueue = new Queue("document-generation", { connection: redisConnection });
const workflowQueue = new Queue("workflow-engine", { connection: redisConnection });

export async function getQueueStats() {
  const [docCounts, workflowCounts] = await Promise.all([
    docQueue.getJobCounts("active", "waiting", "completed", "failed", "delayed"),
    workflowQueue.getJobCounts("active", "waiting", "completed", "failed", "delayed"),
  ]);

  return {
    documentGeneration: docCounts,
    workflowEngine: workflowCounts,
  };
}

export async function listAllDocuments(
  fastify: FastifyInstance,
  params: { status?: string; page?: number; limit?: number }
) {
  const page = params.page || 1;
  const limit = params.limit || 25;
  const skip = (page - 1) * limit;

  const where: any = {};
  if (params.status) {
    where.status = params.status;
  }

  const [data, total] = await Promise.all([
    fastify.prisma.document.findMany({
      where,
      include: {
        tenant: { select: { id: true, name: true } },
        projects: { include: { project: { select: { id: true, name: true } } } },
        clients: { include: { client: { select: { id: true, companyName: true, firstName: true, lastName: true } } } },
        template: { select: { id: true, name: true, category: true } },
        generatedBy: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    fastify.prisma.document.count({ where }),
  ]);

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function retryDocument(fastify: FastifyInstance, id: string) {
  const doc = await fastify.prisma.document.findUnique({
    where: { id },
    include: {
      projects: { select: { projectId: true }, take: 1 },
      clients: { select: { clientId: true }, take: 1 },
    },
  });
  if (!doc) throw fastify.httpErrors.notFound("Document not found");
  if (doc.status !== "FAILED") {
    throw fastify.httpErrors.badRequest("Only failed documents can be retried");
  }

  // Reset status
  await fastify.prisma.document.update({
    where: { id },
    data: { status: "PENDING", errorMessage: null },
  });

  // Re-enqueue
  await docQueue.add("generate", {
    documentId: doc.id,
    tenantId: doc.tenantId,
    projectId: doc.projects[0]?.projectId,
    clientId: doc.clients[0]?.clientId,
    templateId: doc.templateId,
  });

  return { success: true, documentId: id };
}
