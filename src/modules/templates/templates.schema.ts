import { z } from "zod";

export const createTemplateSchema = z.object({
  category: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  content: z.string().optional(),
});

export const updateTemplateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  fileName: z.string().max(200).optional(),
  category: z.string().min(1).max(50).optional(),
  // Source / scope: "system" = global (tenantId null), "tenant" = current tenant.
  source: z.enum(["system", "tenant"]).optional(),
  description: z.string().max(1000).optional(),
  content: z.string().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
  // Grupurile DOCX: codul distribuitorului (`Distributor.code`) pentru secțiunea „Dosare”.
  distributorCode: z.string().trim().max(40).regex(/^[A-Z0-9_]*$/).nullable().optional()
    .transform((v) => (v === "" ? null : v)),
});

// Template categories (platform-global, master admin only) — mirrors the
// TemplateCategory Prisma model.
export const createCategorySchema = z.object({
  code: z.string().min(1).max(50).regex(/^[A-Za-z0-9_-]+$/, "Codul poate conține doar litere, cifre, _ și -"),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  icon: z.string().max(100).optional(),
  color: z.string().max(50).optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  registrySeriesCode: z.string().max(50).optional(),
});

export const updateCategorySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  icon: z.string().max(100).nullable().optional(),
  color: z.string().max(50).nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  // "" or null → fall back to the default series.
  registrySeriesCode: z.string().max(50).nullable().optional(),
});

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
