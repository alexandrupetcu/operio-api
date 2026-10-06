import { z } from "zod";

export const startWorkflowSchema = z.object({
  workflowDefinitionId: z.string().min(1),
  entityType: z.string().default("project"),
  entityId: z.string().min(1),
});

export const completeStepSchema = z.object({
  output: z.any().optional(),
});

export const failStepSchema = z.object({
  error: z.string().optional(),
});

export const executeEventSchema = z.object({
  actionId: z.string().min(1),
  triggerPayload: z.object({
    fieldKey: z.string().optional(),
    value: z.any().optional(),
    formValues: z.record(z.unknown()).optional(),
  }),
});

export const addAdHocStepSchema = z.object({
  name: z.string().min(1).max(200),
  assignedUserId: z.string().cuid().nullable().optional(),
  // ISO datetime string; the client builds it from a native date input.
  dueAt: z.string().datetime().nullable().optional(),
  requiresDocument: z.boolean().optional().default(false),
});

export type StartWorkflowInput = z.infer<typeof startWorkflowSchema>;
export type AddAdHocStepInput = z.infer<typeof addAdHocStepSchema>;
export type CompleteStepInput = z.infer<typeof completeStepSchema>;
export type FailStepInput = z.infer<typeof failStepSchema>;
export type ExecuteEventInput = z.infer<typeof executeEventSchema>;
