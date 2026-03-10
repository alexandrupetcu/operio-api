import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import { createTemplateSchema, updateTemplateSchema } from "./templates.schema.js";
import * as templatesService from "./templates.service.js";
import { generateTemplateContent } from "./templates.ai.js";
import type { DocumentCategory } from "@prisma/client";

export default async function templatesRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  // List templates (paginated)
  fastify.get("/", async (request) => {
    const { category, search, page, limit } = request.query as {
      category?: string;
      search?: string;
      page?: string;
      limit?: string;
    };
    return templatesService.list(fastify, request.tenantId, {
      category,
      search,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  });

  // Generate template content with AI
  fastify.post<{ Body: { category: string; prompt?: string } }>(
    "/generate",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      const { category, prompt } = request.body as {
        category: string;
        prompt?: string;
      };
      if (!category) {
        throw fastify.httpErrors.badRequest("Category is required");
      }
      const content = await generateTemplateContent(fastify, category, prompt);
      return { content };
    }
  );

  // Get template by ID
  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    return templatesService.getById(
      fastify,
      request.tenantId,
      request.params.id
    );
  });

  // Create template from JSON body (HTML content)
  fastify.post(
    "/",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request, reply) => {
      const contentType = request.headers["content-type"] ?? "";

      // Multipart: file upload (DOCX template)
      if (contentType.includes("multipart/form-data")) {
        const file = await request.file();
        if (!file) throw fastify.httpErrors.badRequest("File is required");

        const fields = file.fields as Record<string, any>;
        const name = fields.name?.value;
        const category = fields.category?.value;

        if (!name || !category) {
          throw fastify.httpErrors.badRequest("Name and category are required");
        }

        const template = await templatesService.createFromFile(
          fastify,
          request.tenantId,
          file,
          name,
          category as DocumentCategory
        );
        return reply.status(201).send(template);
      }

      // JSON body: HTML content template
      const body = createTemplateSchema.parse(request.body);
      const template = await templatesService.create(
        fastify,
        request.tenantId,
        body
      );
      return reply.status(201).send(template);
    }
  );

  // Update template
  fastify.patch<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      const body = updateTemplateSchema.parse(request.body);
      return templatesService.update(
        fastify,
        request.tenantId,
        request.params.id,
        body
      );
    }
  );

  // Delete template
  fastify.delete<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      return templatesService.remove(
        fastify,
        request.tenantId,
        request.params.id
      );
    }
  );
}
