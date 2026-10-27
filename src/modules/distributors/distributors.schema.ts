import { z } from "zod";

/**
 * Datele agenției distribuitorului (OSD) folosite pe documentele de dosar
 * ({osd_adresa}, {osd_regiune}, {osd_sector}, {osd_telefon}, {osd_fax}, {osd_director}).
 * Câmpurile necunoscute se păstrează (`passthrough`), ca datele vechi să nu se piardă.
 */
export const distributorContactSchema = z
  .object({
    address: z.string().trim().max(200).optional(),
    region: z.string().trim().max(80).optional(),
    sector: z.string().trim().max(80).optional(),
    phone: z.string().trim().max(60).optional(),
    fax: z.string().trim().max(60).optional(),
    director: z.string().trim().max(120).optional(),
  })
  .passthrough();

export const createDistributorSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  contactJson: distributorContactSchema.nullable().optional(),
  isActive: z.boolean().optional(),
});

export const updateDistributorSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  contactJson: distributorContactSchema.nullable().optional(),
  isActive: z.boolean().optional(),
});

export type CreateDistributorInput = z.infer<typeof createDistributorSchema>;
export type UpdateDistributorInput = z.infer<typeof updateDistributorSchema>;
