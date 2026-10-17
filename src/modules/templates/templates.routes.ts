import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole, requireMasterAdmin } from "../../lib/rbac.js";
import {
  createTemplateSchema,
  updateTemplateSchema,
  createCategorySchema,
  updateCategorySchema,
} from "./templates.schema.js";
import * as templatesService from "./templates.service.js";
import { generateTemplateContent } from "./templates.ai.js";

export default async function templatesRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  // ── Admin-only endpoints ──────────────────────────────────────────

  // List ALL templates (admin view, no tenant filter)
  fastify.get(
    "/admin",
    { onRequest: [requireMasterAdmin()] },
    async (request) => {
      const { category, search, scope, type, page, limit } = request.query as {
        category?: string;
        search?: string;
        scope?: "all" | "system" | "tenant";
        type?: "all" | "html" | "docx" | "group";
        page?: string;
        limit?: string;
      };
      return templatesService.listAdmin(fastify, {
        category,
        search,
        scope,
        type,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
      });
    }
  );

  // Download template file (presigned URL)
  fastify.get<{ Params: { id: string } }>(
    "/:id/download",
    { onRequest: [requireMasterAdmin()] },
    async (request) => {
      return templatesService.getDownloadUrl(fastify, request.params.id);
    }
  );

  // Raw DOCX bytes (for the in-app editor — same-origin fetch, avoids S3 CORS)
  fastify.get<{ Params: { id: string } }>(
    "/:id/content",
    { onRequest: [requireMasterAdmin()] },
    async (request, reply) => {
      const { buffer } = await templatesService.getFileContent(fastify, request.params.id);
      reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      return reply.send(buffer);
    }
  );

  // Replace DOCX file on an existing template
  fastify.patch<{ Params: { id: string } }>(
    "/:id/file",
    { onRequest: [requireMasterAdmin()] },
    async (request) => {
      const file = await request.file();
      if (!file) throw fastify.httpErrors.badRequest("File is required");
      return templatesService.replaceFile(fastify, request.params.id, file);
    }
  );

  // Bulk delete templates
  fastify.post(
    "/bulk-delete",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      const { ids } = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) }).parse(request.body);
      return templatesService.bulkRemove(fastify, request.tenantId, ids, request.user.role);
    }
  );

  // ── DOCX Groups ─────────────────────────────────────────────────────

  // Create a DOCX group (members added afterwards)
  fastify.post(
    "/groups",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request, reply) => {
      const { name, category, description } = request.body as {
        name?: string;
        category?: string;
        description?: string;
      };
      if (!name || !category) throw fastify.httpErrors.badRequest("name and category are required");
      const group = await templatesService.createGroup(fastify, request.tenantId, { name, category, description });
      return reply.status(201).send(group);
    }
  );

  // List a group's DOCX members (ordered)
  fastify.get<{ Params: { id: string } }>("/:id/docs", async (request) => {
    return templatesService.listGroupDocs(fastify, request.tenantId, request.params.id);
  });

  // Upload one or more DOCX files into a group
  fastify.post<{ Params: { id: string } }>(
    "/:id/docs",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request, reply) => {
      const parts = request.parts();
      const files: Array<{ buffer: Buffer; filename: string; mimetype: string }> = [];
      for await (const part of parts) {
        if (part.type === "file") {
          files.push({ buffer: await part.toBuffer(), filename: part.filename, mimetype: part.mimetype });
        }
      }
      if (files.length === 0) throw fastify.httpErrors.badRequest("At least one file is required");
      const created = await templatesService.addGroupDocs(fastify, request.tenantId, request.params.id, files);
      return reply.status(201).send(created);
    }
  );

  // Reorder a group's members
  fastify.patch<{ Params: { id: string } }>(
    "/:id/docs/reorder",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      const { ids } = request.body as { ids?: string[] };
      if (!ids?.length) throw fastify.httpErrors.badRequest("ids required");
      return templatesService.reorderGroupDocs(fastify, request.tenantId, request.params.id, ids);
    }
  );

  // Remove a member from a group
  fastify.delete<{ Params: { id: string; docId: string } }>(
    "/:id/docs/:docId",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      return templatesService.removeGroupDoc(fastify, request.tenantId, request.params.id, request.params.docId);
    }
  );

  // Download the whole group as a ZIP of its DOCX files
  fastify.get<{ Params: { id: string } }>("/:id/zip", async (request, reply) => {
    const { buffer, filename } = await templatesService.getGroupZip(fastify, request.tenantId, request.params.id);
    reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="${filename}"`);
    return reply.send(buffer);
  });

  // ── Template Categories CRUD ────────────────────────────────────────

  // List all categories
  fastify.get("/categories", async () => {
    return fastify.prisma.templateCategory.findMany({
      orderBy: { sortOrder: "asc" },
    });
  });

  // Categories are platform-global (no tenantId) → master admin only.

  // Create category (master admin only)
  fastify.post(
    "/categories",
    { onRequest: [requireMasterAdmin()] },
    async (request, reply) => {
      const body = createCategorySchema.parse(request.body);
      const category = await fastify.prisma.templateCategory.create({
        data: {
          code: body.code.toUpperCase(),
          name: body.name,
          description: body.description,
          icon: body.icon,
          color: body.color,
          sortOrder: body.sortOrder,
          registrySeriesCode: body.registrySeriesCode || null,
        },
      });
      return reply.status(201).send(category);
    }
  );

  // Update category (master admin only)
  fastify.patch<{ Params: { id: string } }>(
    "/categories/:id",
    { onRequest: [requireMasterAdmin()] },
    async (request) => {
      const { name, description, icon, color, isActive, sortOrder, registrySeriesCode } =
        updateCategorySchema.parse(request.body);
      return fastify.prisma.templateCategory.update({
        where: { id: request.params.id },
        data: {
          ...(name !== undefined && { name }),
          ...(description !== undefined && { description }),
          ...(icon !== undefined && { icon }),
          ...(color !== undefined && { color }),
          ...(isActive !== undefined && { isActive }),
          ...(sortOrder !== undefined && { sortOrder }),
          // "" → null (fall back to default series); a code → per-category series.
          ...(registrySeriesCode !== undefined && {
            registrySeriesCode: registrySeriesCode ? registrySeriesCode : null,
          }),
        },
      });
    }
  );

  // Delete category (master admin only)
  fastify.delete<{ Params: { id: string } }>(
    "/categories/:id",
    { onRequest: [requireMasterAdmin()] },
    async (request) => {
      // Check if any templates use this category
      const category = await fastify.prisma.templateCategory.findUnique({
        where: { id: request.params.id },
        include: { _count: { select: { templates: true } } },
      });
      if (!category) throw fastify.httpErrors.notFound("Category not found");
      if (category._count.templates > 0) {
        throw fastify.httpErrors.conflict(
          `Categoria are ${category._count.templates} template-uri asociate. Ștergeți sau mutați template-urile mai întâi.`
        );
      }
      return fastify.prisma.templateCategory.delete({
        where: { id: request.params.id },
      });
    }
  );

  // ── Regular endpoints ───────────────────────────────────────────

  // List templates (paginated)
  fastify.get("/", async (request) => {
    const { category, search, type, page, limit } = request.query as {
      category?: string;
      search?: string;
      type?: "all" | "html" | "docx" | "group";
      page?: string;
      limit?: string;
    };
    return templatesService.list(fastify, request.tenantId, {
      category,
      search,
      type,
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
          category as string
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
        body,
        request.user.role
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
        request.params.id,
        request.user.role
      );
    }
  );
}
