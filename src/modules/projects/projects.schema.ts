import { z } from "zod";
import { createClientSchema } from "../clients/clients.schema.js";

export const createProjectSchema = z.object({
  clientId: z.string().cuid(),
  projectTypeId: z.string().cuid(),
  distributorId: z.string().cuid().optional().nullable(),
  name: z.string().min(1).max(200),
  address: z.string().min(1),
  city: z.string().min(1),
  county: z.string().min(1),
  observations: z.string().optional().nullable(),
  participareISC: z.boolean().optional(),
  metadata: z.any().optional(),
  scheduledDate: z.string().datetime().optional(),
  assignedEmployeeId: z.string().cuid().optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  address: z.string().min(1).optional(),
  city: z.string().min(1).optional(),
  county: z.string().min(1).optional(),
  distributorId: z.string().cuid().optional().nullable(),
  observations: z.string().optional().nullable(),
  participareISC: z.boolean().optional(),
  status: z.string().optional(),
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
    projectTypeId: z.string().cuid(),
    distributorId: z.string().cuid().optional().nullable(),
    name: z.string().min(1).max(200),
    address: z.string().min(1),
    city: z.string().min(1),
    county: z.string().min(1),
    observations: z.string().optional().nullable(),
    participareISC: z.boolean().optional(),
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
