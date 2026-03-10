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

export type GenerateDocumentsInput = z.infer<typeof generateDocumentsSchema>;
export type GenerateBatchInput = z.infer<typeof generateBatchSchema>;
