import { z } from "zod";

export const initializePlanSchema = z.object({
  templateId: z.string().min(1).optional(),
  selectedStepOrders: z.array(z.number().int()).optional(),
});

export const updateTaskSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional().nullable(),
  institution: z.string().optional().nullable(),
  status: z.enum(["TODO", "IN_PROGRESS", "WAITING", "COMPLETED", "SKIPPED"]).optional(),
  estimatedDays: z.number().int().min(0).optional().nullable(),
  startDate: z.string().datetime().optional().nullable(),
  dueDate: z.string().datetime().optional().nullable(),
  notes: z.string().optional().nullable(),
  dependsOnTaskId: z.string().min(1).optional().nullable(),
});

export const createTaskSchema = z.object({
  sortOrder: z.number().int().min(0),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  institution: z.string().optional(),
  estimatedDays: z.number().int().min(0).optional(),
  dependsOnTaskId: z.string().min(1).optional(),
});

export const reorderTasksSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string().min(1),
      sortOrder: z.number().int().min(0),
    })
  ),
});

export type InitializePlanInput = z.infer<typeof initializePlanSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type ReorderTasksInput = z.infer<typeof reorderTasksSchema>;
