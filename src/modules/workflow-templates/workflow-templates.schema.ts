import { z } from "zod";

const templateStepSchema = z.object({
  id: z.string().cuid().optional(),
  sortOrder: z.number().int().min(0),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  institution: z.string().optional(),
  estimatedDays: z.number().int().min(0).default(30),
  requiredDocuments: z.array(z.string()).default([]),
  dependsOnStepOrder: z.number().int().nullable().optional(),
  isSelectable: z.boolean().default(false),
  isSelectedByDefault: z.boolean().default(true),
});

export const createTemplateSchema = z.object({
  projectType: z.enum(["BRANSAMENT", "CONDUCTA", "REVIZIE_CENTRALA", "DOSAR_ISCIR"]),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  isDefault: z.boolean().default(false),
  steps: z.array(templateStepSchema).min(1),
});

export const updateTemplateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const updateStepsSchema = z.object({
  steps: z.array(templateStepSchema).min(1),
});

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
export type UpdateStepsInput = z.infer<typeof updateStepsSchema>;
