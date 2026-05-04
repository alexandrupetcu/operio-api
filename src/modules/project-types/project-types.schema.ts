import { z } from "zod";

export const createProjectTypeSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_]+$/, "Code must be lowercase alphanumeric with underscores"),
  name: z.string().min(1).max(255),
  description: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
  metadataJson: z.any().optional(),
});

export const updateProjectTypeSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
  metadataJson: z.any().optional(),
});

export type CreateProjectTypeInput = z.infer<typeof createProjectTypeSchema>;
export type UpdateProjectTypeInput = z.infer<typeof updateProjectTypeSchema>;
