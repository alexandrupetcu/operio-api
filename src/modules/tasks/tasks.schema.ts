import { z } from "zod";

/**
 * Columns the task list may be sorted by (allowlist for `sortBy`). Lives here
 * (not in tasks.service.ts) so both routes and service can import it without
 * a routes<->service cycle; the service must pass it to `paginationArgs`.
 */
export const TASKS_SORTABLE = ["title", "dueAt", "priority", "status", "createdAt", "updatedAt"] as const;

export const createTaskSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  taskType: z.string().default("manual"),
  status: z.string().default("open"),
  priority: z.string().default("normal"),
  projectId: z.string().cuid().optional(),
  clientId: z.string().cuid().optional(),
  workflowInstanceId: z.string().cuid().optional(),
  workflowStepInstanceId: z.string().cuid().optional(),
  assignedUserId: z.string().cuid().optional(),
  dueAt: z.string().datetime().optional(),
  metadataJson: z.any().optional(),
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional().nullable(),
  status: z.enum(["open", "in_progress", "done", "cancelled", "overdue"]).optional(),
  priority: z.string().optional(),
  assignedUserId: z.string().cuid().optional().nullable(),
  dueAt: z.string().datetime().optional().nullable(),
  completedAt: z.string().datetime().optional().nullable(),
  metadataJson: z.any().optional(),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
