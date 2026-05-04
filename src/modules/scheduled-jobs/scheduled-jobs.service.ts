import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import type { PaginationQuery } from "../../lib/pagination.js";
import { paginationArgs, paginationMeta } from "../../lib/pagination.js";

export async function list(
  fastify: FastifyInstance,
  tenantId: string,
  query: PaginationQuery & {
    status?: string;
    jobType?: string;
  }
) {
  const where: Prisma.ScheduledJobWhereInput = {
    tenantId,
    ...(query.status && { status: query.status }),
    ...(query.jobType && { jobType: query.jobType }),
  };

  const [data, total] = await Promise.all([
    fastify.prisma.scheduledJob.findMany({
      where,
      ...paginationArgs(query),
    }),
    fastify.prisma.scheduledJob.count({ where }),
  ]);

  return { data, ...paginationMeta(total, query) };
}

export async function createJob(
  fastify: FastifyInstance,
  tenantId: string,
  jobType: string,
  runAt: Date,
  payload?: any,
  relatedEntity?: { type: string; id: string },
  maxAttempts?: number
) {
  return fastify.prisma.scheduledJob.create({
    data: {
      tenantId,
      jobType,
      runAt,
      status: "pending",
      payloadJson: payload as Prisma.InputJsonValue | undefined,
      relatedEntityType: relatedEntity?.type,
      relatedEntityId: relatedEntity?.id,
      ...(maxAttempts !== undefined && { maxAttempts }),
    },
  });
}

export async function listPending(fastify: FastifyInstance) {
  return fastify.prisma.scheduledJob.findMany({
    where: {
      status: "pending",
      runAt: { lte: new Date() },
    },
    orderBy: { runAt: "asc" },
  });
}

export async function lock(fastify: FastifyInstance, jobId: string) {
  // Optimistic locking: only update if status is still "pending"
  const result = await fastify.prisma.scheduledJob.updateMany({
    where: {
      id: jobId,
      status: "pending",
    },
    data: {
      status: "locked",
      lockedAt: new Date(),
    },
  });

  if (result.count === 0) {
    throw fastify.httpErrors.conflict(
      "Job is no longer pending (already locked or processed)"
    );
  }

  return fastify.prisma.scheduledJob.findUnique({ where: { id: jobId } });
}

export async function complete(
  fastify: FastifyInstance,
  jobId: string,
  result?: any
) {
  return fastify.prisma.scheduledJob.update({
    where: { id: jobId },
    data: {
      status: "processed",
      processedAt: new Date(),
      ...(result !== undefined && {
        payloadJson: result as Prisma.InputJsonValue,
      }),
    },
  });
}

export async function fail(
  fastify: FastifyInstance,
  jobId: string,
  error?: string
) {
  const job = await fastify.prisma.scheduledJob.findUnique({
    where: { id: jobId },
  });
  if (!job) throw fastify.httpErrors.notFound("Scheduled job not found");

  const newAttempts = job.attempts + 1;
  const reachedMax = newAttempts >= job.maxAttempts;

  return fastify.prisma.scheduledJob.update({
    where: { id: jobId },
    data: {
      attempts: newAttempts,
      status: reachedMax ? "failed" : "pending",
      lockedAt: null,
      ...(reachedMax && { failedAt: new Date() }),
      ...(error && { errorMessage: error }),
    },
  });
}

export async function retryJob(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const job = await fastify.prisma.scheduledJob.findFirst({
    where: { id, tenantId },
  });
  if (!job) throw fastify.httpErrors.notFound("Scheduled job not found");

  if (job.status !== "failed") {
    throw fastify.httpErrors.badRequest("Only failed jobs can be retried");
  }

  return fastify.prisma.scheduledJob.update({
    where: { id },
    data: {
      status: "pending",
      attempts: 0,
      lockedAt: null,
      failedAt: null,
      errorMessage: null,
    },
  });
}

export async function cancelJob(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const job = await fastify.prisma.scheduledJob.findFirst({
    where: { id, tenantId },
  });
  if (!job) throw fastify.httpErrors.notFound("Scheduled job not found");

  if (job.status !== "pending" && job.status !== "failed") {
    throw fastify.httpErrors.badRequest(
      "Only pending or failed jobs can be cancelled"
    );
  }

  return fastify.prisma.scheduledJob.update({
    where: { id },
    data: { status: "cancelled" },
  });
}
