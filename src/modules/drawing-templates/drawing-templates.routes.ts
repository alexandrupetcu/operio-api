import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import { z } from "zod";
import * as drawingTemplatesService from "./drawing-templates.service.js";

const createSchema = z.object({
  name: z.string().min(1).max(200),
  canvasJson: z.record(z.unknown()),
  isGlobal: z.boolean().optional().default(false),
});

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  canvasJson: z.record(z.unknown()).optional(),
});

export type CreateDrawingTemplateInput = z.infer<typeof createSchema>;
export type UpdateDrawingTemplateInput = z.infer<typeof updateSchema>;

export default async function drawingTemplatesRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  // List all templates visible to this tenant (own + global)
  fastify.get("/", async (request) => {
    return drawingTemplatesService.list(fastify, request.tenantId);
  });

  // Get single template
  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    return drawingTemplatesService.getById(fastify, request.tenantId, request.params.id);
  });

  // Create template — tenant ADMIN/MANAGER create tenant rows; global rows are master-only.
  fastify.post("/", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request, reply) => {
      const body = createSchema.parse(request.body);
      if (body.isGlobal && request.user.role !== "MASTER_ADMIN") {
        throw fastify.httpErrors.forbidden("Doar administratorul platformei poate crea șabloane globale");
      }
      const template = await drawingTemplatesService.create(
        fastify,
        body.isGlobal ? null : request.tenantId,
        body
      );
      return reply.status(201).send(template);
    },
  });

  // Update template — own tenant rows only (global rows: master admin).
  fastify.patch<{ Params: { id: string } }>("/:id", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request) => {
      const body = updateSchema.parse(request.body);
      return drawingTemplatesService.update(
        fastify,
        request.tenantId,
        request.user.role,
        request.params.id,
        body
      );
    },
  });

  // Delete template — own tenant rows only (global rows: master admin).
  fastify.delete<{ Params: { id: string } }>("/:id", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request) => {
      return drawingTemplatesService.remove(fastify, request.tenantId, request.user.role, request.params.id);
    },
  });
}
