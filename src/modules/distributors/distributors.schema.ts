import { z } from "zod";

export const createDistributorSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  contactJson: z.any().optional(),
  isActive: z.boolean().optional(),
});

export const updateDistributorSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  contactJson: z.any().optional(),
  isActive: z.boolean().optional(),
});

export type CreateDistributorInput = z.infer<typeof createDistributorSchema>;
export type UpdateDistributorInput = z.infer<typeof updateDistributorSchema>;
