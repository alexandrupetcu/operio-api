import { z } from "zod";

const codeField = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9_]+$/, "Code must be lowercase alphanumeric with underscores");

export const createWorkflowDefinitionSchema = z.object({
  code: codeField.optional(),
  name: z.string().min(1).max(200),
  description: z.string().optional().nullable(),
  category: z.string().max(50).optional().nullable(),
  projectTypeId: z.string().min(1).optional().nullable(),
  entityType: z.string().default("project"),
  configJson: z.any().optional(),
});

export const updateWorkflowDefinitionSchema = z.object({
  code: codeField.optional(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional().nullable(),
  category: z.string().max(50).optional().nullable(),
  configJson: z.any().optional(),
});

export const createStepSchema = z.object({
  code: codeField,
  name: z.string().min(1).max(200),
  stepType: z.enum([
    "human_task",
    "timer_wait",
    "decision",
    "document_generation",
    "notification",
    "approval",
    "system_action",
    "sub_workflow",
    "final",
  ]),
  orderIndex: z.number().int().min(0).default(0),
  isStart: z.boolean().optional(),
  isTerminal: z.boolean().optional(),
  joinMode: z.enum(["all", "any"]).optional().nullable(),
  nameTemplate: z.string().max(500).optional().nullable(),
  configJson: z.any().optional(),
  formSchemaJson: z.any().optional(),
  validationSchemaJson: z.any().optional(),
  uiSchemaJson: z.any().optional(),
});

export const updateStepSchema = z.object({
  code: codeField.optional(),
  name: z.string().min(1).max(200).optional(),
  stepType: z
    .enum([
      "human_task",
      "timer_wait",
      "decision",
      "document_generation",
      "notification",
      "approval",
      "system_action",
      "sub_workflow",
      "final",
    ])
    .optional(),
  orderIndex: z.number().int().min(0).optional(),
  isStart: z.boolean().optional(),
  isTerminal: z.boolean().optional(),
  joinMode: z.enum(["all", "any"]).optional().nullable(),
  nameTemplate: z.string().max(500).optional().nullable(),
  configJson: z.any().optional(),
  formSchemaJson: z.any().optional(),
  validationSchemaJson: z.any().optional(),
  uiSchemaJson: z.any().optional(),
});

export const createTransitionSchema = z.object({
  fromStepId: z.string().cuid(),
  toStepId: z.string().cuid(),
  transitionType: z.enum([
    "default",
    "success",
    "failure",
    "timeout",
    "conditional",
    "manual",
  ]),
  label: z.string().max(200).optional(),
  priority: z.number().int().optional(),
  conditionJson: z.any().optional(),
  configJson: z.any().optional(),
  spawnMode: z.enum(["single", "foreach"]).optional(),
  foreachPath: z.string().max(200).optional().nullable(),
  itemContextKey: z.string().max(100).optional().nullable(),
});

export const updateTransitionSchema = z.object({
  label: z.string().max(200).optional().nullable(),
  transitionType: z
    .enum(["default", "success", "failure", "timeout", "conditional", "manual"])
    .optional(),
  conditionJson: z.any().optional(),
  priority: z.number().int().optional(),
  spawnMode: z.enum(["single", "foreach"]).optional(),
  foreachPath: z.string().max(200).optional().nullable(),
  itemContextKey: z.string().max(100).optional().nullable(),
});

export const createStepActionSchema = z.object({
  triggerEvent: z.enum([
    "on_enter",
    "on_complete",
    "on_timeout",
    "on_fail",
    "on_field_change",
    "on_file_upload",
  ]),
  actionType: z.enum([
    "create_task",
    "schedule_timer",
    "send_notification",
    "generate_document",
    "create_followup",
    "assign_user",
    "call_webhook",
    "update_project_status",
    "call_api",
  ]),
  targetFieldKey: z.string().max(100).optional().nullable(),
  actionConfigJson: z.any().optional(),
});

export const updateStepActionSchema = z.object({
  triggerEvent: z
    .enum([
      "on_enter",
      "on_complete",
      "on_timeout",
      "on_fail",
      "on_field_change",
      "on_file_upload",
    ])
    .optional(),
  actionType: z
    .enum([
      "create_task",
      "schedule_timer",
      "send_notification",
      "generate_document",
      "create_followup",
      "assign_user",
      "call_webhook",
      "update_project_status",
      "call_api",
    ])
    .optional(),
  targetFieldKey: z.string().max(100).optional().nullable(),
  actionConfigJson: z.any().optional(),
});

export const cloneWorkflowSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  code: codeField.optional(),
});

export type CreateWorkflowDefinitionInput = z.infer<typeof createWorkflowDefinitionSchema>;
export type UpdateWorkflowDefinitionInput = z.infer<typeof updateWorkflowDefinitionSchema>;
export type CreateStepInput = z.infer<typeof createStepSchema>;
export type UpdateStepInput = z.infer<typeof updateStepSchema>;
export type CreateTransitionInput = z.infer<typeof createTransitionSchema>;
export type UpdateTransitionInput = z.infer<typeof updateTransitionSchema>;
export type CreateStepActionInput = z.infer<typeof createStepActionSchema> & { stepId: string };
export type UpdateStepActionInput = z.infer<typeof updateStepActionSchema>;
export type CloneWorkflowInput = z.infer<typeof cloneWorkflowSchema>;
