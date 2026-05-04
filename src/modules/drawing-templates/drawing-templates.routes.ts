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

  // Create template
  fastify.post("/", {
    handler: async (request, reply) => {
      const body = createSchema.parse(request.body);
      // Only ADMIN/MANAGER can create global templates
      if (body.isGlobal && !["MASTER_ADMIN", "ADMIN"].includes(request.user.role)) {
        throw fastify.httpErrors.forbidden("Only admins can create global templates");
      }
      const template = await drawingTemplatesService.create(
        fastify,
        body.isGlobal ? null : request.tenantId,
        body
      );
      return reply.status(201).send(template);
    },
  });

  // Update template
  fastify.patch<{ Params: { id: string } }>("/:id", {
    handler: async (request) => {
      const body = updateSchema.parse(request.body);
      return drawingTemplatesService.update(fastify, request.tenantId, request.params.id, body);
    },
  });

  // Delete template
  fastify.delete<{ Params: { id: string } }>("/:id", {
    handler: async (request) => {
      return drawingTemplatesService.remove(fastify, request.tenantId, request.params.id);
    },
  });
}
