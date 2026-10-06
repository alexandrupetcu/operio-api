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
});

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
