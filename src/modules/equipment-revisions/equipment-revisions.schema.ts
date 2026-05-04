import { z } from "zod";

export const createRevisionSchema = z.object({
  revisionDate: z.string().datetime({ offset: true }).or(z.string().date()),
  operatorName: z.string().optional().nullable(),
  operatorAddress: z.string().optional().nullable(),
  operatorPhone: z.string().optional().nullable(),
  operatorEmail: z.string().optional().nullable(),
  analyzerName: z.string().optional().nullable(),
  analyzerSerial: z.string().optional().nullable(),
  analysisData: z.record(z.unknown()).optional().nullable(),
  rawText: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  s3Key: z.string().optional().nullable(),
  fileName: z.string().optional().nullable(),
});

export const updateRevisionSchema = createRevisionSchema.partial();

export type CreateRevisionInput = z.infer<typeof createRevisionSchema>;
export type UpdateRevisionInput = z.infer<typeof updateRevisionSchema>;
