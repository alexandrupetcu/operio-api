import { z } from "zod";

export const generateDocumentsSchema = z.object({
  templateIds: z.array(z.string().cuid()).min(1),
});

export const generateBatchSchema = z.object({
  category: z.enum([
    "CARTE_BRANSAMENT",
    "CARTE_CONDUCTA",
    "DOSAR_ISCIR",
    "REVIZIE_CENTRALA",
  ]),
});

export const contractContextSchema = z.object({
  services: z.array(z.object({
    name: z.string(),
    unit: z.string().optional(),
    price: z.number().optional(),
  })).optional(),
  customServices: z.string().optional(),
  totalPrice: z.number().optional(),
  paymentMethod: z.string().optional(),
  // Addendum fields
  parentContractName: z.string().optional(),
  parentContractDate: z.string().optional(),
  addendumNumber: z.number().optional(),
  modifications: z.string().optional(),
}).optional();

export const generateClientDocumentsSchema = z.object({
  templateIds: z.array(z.string().cuid()).min(1),
  context: contractContextSchema,
});

export type GenerateDocumentsInput = z.infer<typeof generateDocumentsSchema>;
export type GenerateBatchInput = z.infer<typeof generateBatchSchema>;
export type GenerateClientDocumentsInput = z.infer<typeof generateClientDocumentsSchema>;
