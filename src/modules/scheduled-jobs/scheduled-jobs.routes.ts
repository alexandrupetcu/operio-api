import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../../lib/rbac.js";
import { paginationSchema } from "../../lib/pagination.js";
import * as scheduledJobsService from "./scheduled-jobs.service.js";

const createJobSchema = z.object({
  jobType: z.string().min(1),
  runAt: z.string().datetime(),
  payloadJson: z.any().optional(),
  relatedEntityType: z.string().optional(),
  relatedEntityId: z.string().optional(),
  maxAttempts: z.number().int().min(1).max(100).optional(),
});

export default async function scheduledJobsRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  // GET / - list jobs with status filter (ADMIN only)
  fastify.get(
    "/",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      const query = paginationSchema.parse(request.query);
      const { status, jobType } = request.query as Record<string, string>;
      return scheduledJobsService.list(fastify, request.tenantId, {
        ...query,
        status,
        jobType,
      });
    }
  );

  // POST / - create a scheduled job (ADMIN only)
  fastify.post(
    "/",
    { onRequest: [requireRole("ADMIN")] },
    async (request, reply) => {
      const body = createJobSchema.parse(request.body);
      const relatedEntity =
        body.relatedEntityType && body.relatedEntityId
          ? { type: body.relatedEntityType, id: body.relatedEntityId }
          : undefined;
      const job = await scheduledJobsService.createJob(
        fastify,
        request.tenantId,
        body.jobType,
        new Date(body.runAt),
        body.payloadJson,
        relatedEntity,
        body.maxAttempts
      );
      return reply.status(201).send(job);
    }
  );

  // POST /:id/process - manually lock and process a job (ADMIN only)
  fastify.post<{ Params: { id: string } }>(
    "/:id/process",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      const job = await scheduledJobsService.lock(
        fastify,
        request.params.id
      );
      return job;
    }
  );

  // POST /:id/retry - retry a failed job (ADMIN only)
  fastify.post<{ Params: { id: string } }>(
    "/:id/retry",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      return scheduledJobsService.retryJob(
        fastify,
        request.tenantId,
        request.params.id
      );
    }
  );

  // POST /:id/cancel - cancel a pending/failed job (ADMIN only)
  fastify.post<{ Params: { id: string } }>(
    "/:id/cancel",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      return scheduledJobsService.cancelJob(
        fastify,
        request.tenantId,
        request.params.id
      );
    }
  );
}
