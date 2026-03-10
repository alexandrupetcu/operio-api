import { z } from "zod";

export const createProjectSchema = z.object({
  clientId: z.string().cuid(),
  type: z.enum(["BRANSAMENT", "CONDUCTA", "REVIZIE_CENTRALA", "DOSAR_ISCIR"]),
  name: z.string().min(1).max(200),
  address: z.string().min(1),
  city: z.string().min(1),
  county: z.string().min(1),
  metadata: z.any().optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  address: z.string().min(1).optional(),
  city: z.string().min(1).optional(),
  county: z.string().min(1).optional(),
  status: z
    .enum([
      "DRAFT",
      "IN_PROGRESS",
      "DOCUMENTS_PENDING",
      "SUBMITTED",
      "APPROVED",
      "COMPLETED",
      "REJECTED",
    ])
    .optional(),
  metadata: z.any().optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
