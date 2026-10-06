import type { FastifyInstance } from "fastify";
import {
  startWorkflowSchema,
  completeStepSchema,
  failStepSchema,
  executeEventSchema,
  addAdHocStepSchema,
} from "./workflow-instances.schema.js";
import * as workflowInstancesService from "./workflow-instances.service.js";
import { requireRole } from "../../lib/rbac.js";
import {
  uploadFile,
  ensureTenantFolder,
  buildStepFileKey,
} from "../../lib/s3.js";

export default async function workflowInstancesRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  // POST /project/:projectId/start — start workflow for a project
  fastify.post<{ Params: { projectId: string } }>(
    "/project/:projectId/start",
    async (request, reply) => {
      const body = startWorkflowSchema.parse({
        ...(request.body as object),
        entityType: "project",
        entityId: request.params.projectId,
      });
      const instance = await workflowInstancesService.startWorkflow(
        fastify,
        request.tenantId,
        request.user.sub,
        body
      );
      return reply.status(201).send(instance);
    }
  );

  // GET /project/:projectId — get instance by project
  fastify.get<{ Params: { projectId: string } }>(
    "/project/:projectId",
    async (request) => {
      return workflowInstancesService.getByProject(
        fastify,
        request.tenantId,
        request.params.projectId
      );
    }
  );

  // POST /:id/step-instances — add an ad-hoc human step to a running instance
  fastify.post<{ Params: { id: string } }>(
    "/:id/step-instances",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request, reply) => {
      const body = addAdHocStepSchema.parse(request.body);
      const stepInstance = await workflowInstancesService.addAdHocStep(
        fastify,
        request.tenantId,
        request.user.sub,
        request.params.id,
        body
      );
      return reply.status(201).send(stepInstance);
    }
  );

  // GET /:id — get by id
  fastify.get<{ Params: { id: string } }>(
    "/:id",
    async (request) => {
      return workflowInstancesService.getById(
        fastify,
        request.tenantId,
        request.params.id
      );
    }
  );

  // GET /:id/logs — get execution logs
  fastify.get<{ Params: { id: string } }>(
    "/:id/logs",
    async (request) => {
      return workflowInstancesService.getLogs(
        fastify,
        request.tenantId,
        request.params.id
      );
    }
  );

  // POST /step-instances/:stepInstanceId/complete — complete step
  // Accepts application/json or multipart/form-data (files are uploaded to S3)
  fastify.post<{ Params: { stepInstanceId: string } }>(
    "/step-instances/:stepInstanceId/complete",
    async (request) => {
      const stepInstanceId = request.params.stepInstanceId;
      const contentType = request.headers["content-type"] ?? "";
      let output: unknown;

      if (contentType.includes("multipart/form-data")) {
        const parts = request.parts();
        const fields: Record<string, string> = {};
        const fileUploads: Array<{
          fieldname: string;
          buffer: Buffer;
          filename: string;
          mimetype: string;
        }> = [];

        for await (const part of parts) {
          if (part.type === "file") {
            fileUploads.push({
              fieldname: part.fieldname,
              buffer: await part.toBuffer(),
              filename: part.filename,
              mimetype: part.mimetype,
            });
          } else {
            fields[part.fieldname] = part.value as string;
          }
        }

        let baseOutput: Record<string, unknown> = {};
        try {
          baseOutput = JSON.parse(fields["payload"] ?? "{}");
        } catch {
          baseOutput = Object.fromEntries(
            Object.entries(fields).filter(([k]) => k !== "payload")
          );
        }

        if (fileUploads.length > 0) {
          const si = await fastify.prisma.workflowStepInstance.findFirst({
            where: { id: stepInstanceId, tenantId: request.tenantId },
            include: { workflowInstance: { select: { entityId: true } } },
          });

          if (si) {
            await ensureTenantFolder(request.tenantId);
            for (const f of fileUploads) {
              const s3Key = buildStepFileKey(
                request.tenantId,
                si.workflowInstance.entityId,
                stepInstanceId,
                f.filename
              );
              await uploadFile(s3Key, f.buffer, f.mimetype);
              baseOutput[f.fieldname] = { s3Key, filename: f.filename, mimetype: f.mimetype };
            }
          }
        }

        output = baseOutput;
      } else {
        const body = completeStepSchema.parse(request.body);
        output = body.output;
      }

      return workflowInstancesService.completeStep(
        fastify,
        request.tenantId,
        request.user.sub,
        stepInstanceId,
        output
      );
    }
  );

  // PATCH /step-instances/:stepInstanceId/output — edit submitted output (data
  // correction, no workflow advancement). Accepts json or multipart (files).
  fastify.patch<{ Params: { stepInstanceId: string } }>(
    "/step-instances/:stepInstanceId/output",
    async (request) => {
      const stepInstanceId = request.params.stepInstanceId;
      const contentType = request.headers["content-type"] ?? "";
      let payload: Record<string, unknown> = {};
      const fileRefs: Record<string, { s3Key: string; filename: string; mimetype: string }> = {};

      if (contentType.includes("multipart/form-data")) {
        const parts = request.parts();
        const fields: Record<string, string> = {};
        const fileUploads: Array<{ fieldname: string; buffer: Buffer; filename: string; mimetype: string }> = [];

        for await (const part of parts) {
          if (part.type === "file") {
            fileUploads.push({
              fieldname: part.fieldname,
              buffer: await part.toBuffer(),
              filename: part.filename,
              mimetype: part.mimetype,
            });
          } else {
            fields[part.fieldname] = part.value as string;
          }
        }

        try {
          payload = JSON.parse(fields["payload"] ?? "{}");
        } catch {
          payload = {};
        }

        if (fileUploads.length > 0) {
          const si = await fastify.prisma.workflowStepInstance.findFirst({
            where: { id: stepInstanceId, tenantId: request.tenantId },
            include: { workflowInstance: { select: { entityId: true } } },
          });
          if (si) {
            await ensureTenantFolder(request.tenantId);
            for (const f of fileUploads) {
              const s3Key = buildStepFileKey(request.tenantId, si.workflowInstance.entityId, stepInstanceId, f.filename);
              await uploadFile(s3Key, f.buffer, f.mimetype);
              fileRefs[f.fieldname] = { s3Key, filename: f.filename, mimetype: f.mimetype };
            }
          }
        }
      } else {
        const body = (request.body ?? {}) as { output?: Record<string, unknown> };
        payload = body.output ?? {};
      }

      return workflowInstancesService.updateStepOutput(
        fastify,
        request.tenantId,
        stepInstanceId,
        payload,
        fileRefs
      );
    }
  );

  // POST /step-files/presign — presigned download URL for a step-uploaded file
  fastify.post("/step-files/presign", async (request) => {
    const { s3Key } = (request.body ?? {}) as { s3Key?: string };
    return workflowInstancesService.getStepFileUrl(fastify, request.tenantId, s3Key ?? "");
  });

  // POST /step-instances/:stepInstanceId/fail — fail step
  fastify.post<{ Params: { stepInstanceId: string } }>(
    "/step-instances/:stepInstanceId/fail",
    async (request) => {
      const body = failStepSchema.parse(request.body);
      return workflowInstancesService.failStep(
        fastify,
        request.tenantId,
        request.user.sub,
        request.params.stepInstanceId,
        body.error
      );
    }
  );

  // POST /step-instances/:stepInstanceId/retry — retry a failed step
  fastify.post<{ Params: { stepInstanceId: string } }>(
    "/step-instances/:stepInstanceId/retry",
    async (request) => {
      await workflowInstancesService.retryStep(
        fastify,
        request.tenantId,
        request.user.sub,
        request.params.stepInstanceId
      );
      return { success: true };
    }
  );

  // POST /step-instances/:stepInstanceId/execute-event — proxy for frontend event listeners
  // Accepts both application/json and multipart/form-data (when a file needs to be forwarded)
  fastify.post<{ Params: { stepInstanceId: string } }>(
    "/step-instances/:stepInstanceId/execute-event",
    async (request) => {
      const contentType = request.headers["content-type"] ?? "";
      const authHeader = request.headers["authorization"];

      let parsedBody: unknown;
      let fileBuffer: Buffer | undefined;
      let fileFilename: string | undefined;
      let fileMimetype: string | undefined;

      if (contentType.includes("multipart/form-data")) {
        const parts = request.parts();
        const fields: Record<string, string> = {};

        for await (const part of parts) {
          if (part.type === "file") {
            fileBuffer = await part.toBuffer();
            fileFilename = part.filename;
            fileMimetype = part.mimetype;
          } else {
            fields[part.fieldname] = part.value as string;
          }
        }

        // Reconstruct body from multipart fields
        try {
          parsedBody = JSON.parse(fields["payload"] ?? "{}");
        } catch {
          parsedBody = fields;
        }
      } else {
        parsedBody = request.body;
      }

      const body = executeEventSchema.parse(parsedBody);

      return workflowInstancesService.executeEvent(
        fastify,
        request.tenantId,
        request.params.stepInstanceId,
        body,
        { fileBuffer, fileFilename, fileMimetype, authHeader }
      );
    }
  );

  // POST /:id/cancel — cancel workflow
  fastify.post<{ Params: { id: string } }>(
    "/:id/cancel",
    async (request) => {
      return workflowInstancesService.cancel(
        fastify,
        request.tenantId,
        request.user.sub,
        request.params.id
      );
    }
  );
}
