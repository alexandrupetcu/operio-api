import { z } from "zod";

export const createSeriesSchema = z.object({
  code: z.string().min(1).max(50).regex(/^[a-z0-9_]+$/, "code must be lowercase alphanumeric with underscores"),
  name: z.string().min(1).max(200),
  direction: z.enum(["IN", "OUT", "INTERNAL"]).default("INTERNAL"),
  prefix: z.string().max(10).optional().nullable(),
  startingNumber: z.number().int().min(1).default(1),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

export const updateSeriesSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  direction: z.enum(["IN", "OUT", "INTERNAL"]).optional(),
  prefix: z.string().max(10).optional().nullable(),
  startingNumber: z.number().int().min(1).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const createEntrySchema = z.object({
  seriesId: z.string().cuid(),
  subject: z.string().min(1).max(500),
  description: z.string().optional(),
  counterpartName: z.string().max(300).optional(),
  fileS3Key: z.string().optional(),
  documentId: z.string().cuid().optional(),
  projectId: z.string().cuid().optional(),
  clientId: z.string().cuid().optional(),
  // Manual override (ADMIN only, validated in route)
  manualNumber: z.number().int().positive().optional(),
  overrideReason: z.string().min(10).max(500).optional(),
}).refine(
  (data) => !data.manualNumber || (data.overrideReason && data.overrideReason.length >= 10),
  { message: "overrideReason (min 10 chars) required when manualNumber is set", path: ["overrideReason"] }
);

export const updateEntrySchema = z.object({
  subject: z.string().min(1).max(500).optional(),
  description: z.string().optional().nullable(),
  counterpartName: z.string().max(300).optional().nullable(),
  fileS3Key: z.string().optional().nullable(),
});

export const voidEntrySchema = z.object({
  voidReason: z.string().min(10).max(500),
});

export type CreateSeriesInput = z.infer<typeof createSeriesSchema>;
export type UpdateSeriesInput = z.infer<typeof updateSeriesSchema>;
export type CreateEntryInput = z.infer<typeof createEntrySchema>;
export type UpdateEntryInput = z.infer<typeof updateEntrySchema>;
export type VoidEntryInput = z.infer<typeof voidEntrySchema>;
