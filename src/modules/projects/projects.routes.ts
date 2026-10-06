import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import { paginationSchema } from "../../lib/pagination.js";
import {
  createProjectSchema,
  updateProjectSchema,
  createProjectWithClientSchema,
} from "./projects.schema.js";
import * as projectsService from "./projects.service.js";
import { uploadFile, getPresignedUrl } from "../../lib/s3.js";

export default async function projectsRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async (request) => {
    const query = paginationSchema.parse(request.query);
    const { status, projectTypeId } = request.query as Record<string, string>;
    return projectsService.list(fastify, request.tenantId, {
      ...query,
      status,
      projectTypeId,
    });
  });

  fastify.get("/calendar", async (request) => {
    const { from, to } = request.query as { from?: string; to?: string };
    if (!from || !to) {
      throw fastify.httpErrors.badRequest("from and to query params are required");
    }
    return projectsService.calendar(fastify, request.tenantId, from, to);
  });

  fastify.get("/stats", async (request) => {
    return projectsService.stats(fastify, request.tenantId);
  });

  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    return projectsService.getById(
      fastify,
      request.tenantId,
      request.params.id
    );
  });

  fastify.post(
    "/",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request, reply) => {
      const body = createProjectSchema.parse(request.body);
      const project = await projectsService.create(
        fastify,
        request.tenantId,
        request.user.sub,
        body
      );
      return reply.status(201).send(project);
    }
  );

  fastify.post(
    "/wizard",
    { onRequest: [requireRole("ADMIN", "MANAGER", "OPERATOR")] },
    async (request, reply) => {
      const body = createProjectWithClientSchema.parse(request.body);
      const project = await projectsService.createWithClient(
        fastify,
        request.tenantId,
        request.user.sub,
        body
      );
      return reply.status(201).send(project);
    }
  );

  fastify.patch<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      const body = updateProjectSchema.parse(request.body);
      return projectsService.update(
        fastify,
        request.tenantId,
        request.params.id,
        body
      );
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      return projectsService.remove(
        fastify,
        request.tenantId,
        request.params.id
      );
    }
  );

  // Save drawing (PNG + Fabric JSON) on project
  fastify.put<{ Params: { id: string } }>(
    "/:id/drawing",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      const { png, canvasJson } = request.body as {
        png: string; // base64 data URL
        canvasJson: object;
      };
      if (!png) throw fastify.httpErrors.badRequest("png is required");

      // Verify project belongs to tenant
      const project = await fastify.prisma.project.findFirst({
        where: { id: request.params.id, tenantId: request.tenantId },
      });
      if (!project) throw fastify.httpErrors.notFound("Project not found");

      // Convert base64 data URL to buffer
      const base64Data = png.replace(/^data:image\/png;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");
      const s3Key = `${request.tenantId}/projects/${request.params.id}/drawing.png`;
      await uploadFile(s3Key, buffer, "image/png");

      return fastify.prisma.project.update({
        where: { id: request.params.id },
        data: {
          drawingS3Key: s3Key,
          drawingJson: canvasJson as any,
        },
      });
    }
  );

  // Get drawing data for a project (includes a short-lived presigned URL
  // for the saved PNG so the frontend can show a read-only preview without
  // mounting the Fabric.js canvas).
  fastify.get<{ Params: { id: string } }>(
    "/:id/drawing",
    async (request) => {
      const project = await fastify.prisma.project.findFirst({
        where: { id: request.params.id, tenantId: request.tenantId },
        select: { drawingS3Key: true, drawingJson: true },
      });
      if (!project) throw fastify.httpErrors.notFound("Project not found");
      const drawingUrl = project.drawingS3Key
        ? await getPresignedUrl(project.drawingS3Key)
        : null;
      return { ...project, drawingUrl };
    }
  );

  // Snooze / dismiss audit-trail for everything that belongs to this project
  // (project itself, tasks, workflow step instances). Drives the Activitate
  // tab and the per-step section in StepCompleteDrawer.
  fastify.get<{ Params: { id: string } }>(
    "/:id/snooze-history",
    async (request) => {
      return projectsService.getProjectSnoozeHistory(
        fastify,
        request.tenantId,
        request.params.id,
      );
    }
  );
}
