import { z } from "zod";
import { createClientSchema } from "../clients/clients.schema.js";

export const createProjectSchema = z.object({
  clientId: z.string().cuid(),
  type: z.enum(["BRANSAMENT", "CONDUCTA", "REVIZIE_CENTRALA", "DOSAR_ISCIR"]),
  name: z.string().min(1).max(200),
  address: z.string().min(1),
  city: z.string().min(1),
  county: z.string().min(1),
  observations: z.string().optional().nullable(),
  metadata: z.any().optional(),
  scheduledDate: z.string().datetime().optional(),
  assignedEmployeeId: z.string().cuid().optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  address: z.string().min(1).optional(),
  city: z.string().min(1).optional(),
  county: z.string().min(1).optional(),
  observations: z.string().optional().nullable(),
  status: z
    .enum([
      "DRAFT",
      "SCHEDULED",
      "IN_PROGRESS",
      "DOCUMENTS_PENDING",
      "SUBMITTED",
      "APPROVED",
      "COMPLETED",
      "REJECTED",
    ])
    .optional(),
  metadata: z.any().optional(),
  scheduledDate: z.string().datetime().optional().nullable(),
  assignedEmployeeId: z.string().cuid().optional().nullable(),
});

export const createProjectWithClientSchema = z.object({
  client: z.union([
    z.object({ id: z.string().cuid() }),
    createClientSchema,
  ]),
  project: z.object({
    type: z.enum(["BRANSAMENT", "CONDUCTA", "REVIZIE_CENTRALA", "DOSAR_ISCIR"]),
    name: z.string().min(1).max(200),
    address: z.string().min(1),
    city: z.string().min(1),
    county: z.string().min(1),
    observations: z.string().optional().nullable(),
    metadata: z.any().optional(),
  }),
  scheduling: z
    .object({
      scheduledDate: z.string().datetime().optional(),
      assignedEmployeeId: z.string().cuid().optional(),
    })
    .optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type CreateProjectWithClientInput = z.infer<typeof createProjectWithClientSchema>;
