import { z } from "zod";

export const createNotificationSchema = z.object({
  channel: z.enum(["in_app", "email", "sms", "webhook"]).default("in_app"),
  subject: z.string().optional(),
  body: z.string().min(1),
  userId: z.string().cuid().optional(),
  clientId: z.string().cuid().optional(),
  projectId: z.string().cuid().optional(),
  taskId: z.string().cuid().optional(),
  workflowInstanceId: z.string().cuid().optional(),
  vehicleId: z.string().cuid().optional(),
  category: z.string().max(50).optional(),
  scheduledAt: z.string().datetime().optional(),
  metadataJson: z.any().optional(),
});

export const updateNotificationSchema = z.object({
  status: z
    .enum(["pending", "scheduled", "sent", "failed", "cancelled"])
    .optional(),
});

export const markReadSchema = z.object({
  ids: z.array(z.string().cuid()).min(1),
});

export type CreateNotificationInput = z.infer<typeof createNotificationSchema>;
export type UpdateNotificationInput = z.infer<typeof updateNotificationSchema>;
export type MarkReadInput = z.infer<typeof markReadSchema>;
