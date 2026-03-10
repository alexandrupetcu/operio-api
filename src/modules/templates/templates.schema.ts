import { z } from "zod";

const categoryEnum = z.enum([
  "CARTE_BRANSAMENT",
  "CARTE_CONDUCTA",
  "DOSAR_ISCIR",
  "REVIZIE_CENTRALA",
  "GDPR",
  "SERVICE_AGREEMENT",
]);

export const createTemplateSchema = z.object({
  category: categoryEnum,
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  content: z.string().optional(),
});

export const updateTemplateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  category: categoryEnum.optional(),
  description: z.string().max(1000).optional(),
  content: z.string().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
