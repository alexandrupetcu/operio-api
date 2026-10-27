import { z } from "zod";
import { createClientSchema } from "../clients/clients.schema.js";

/**
 * Secțiunea „Dosare”: Carte Branșament / Carte Conductă / Dosar ISCIR generate
 * fără tot fluxul de proiect. Stocarea e un `Project` ascuns (`kind="quick_dossier"`).
 */

export const DOSSIER_ROLE_VALUES = [
  "instalator", "proiectant", "rte", "sef_santier", "cq", "diriginte", "verificator", "sudor", "rts",
] as const;

export const dossierTeamMemberSchema = z.object({
  role: z.enum(DOSSIER_ROLE_VALUES),
  employeeId: z.string().cuid().optional().nullable(),
  // Câmpurile alocării pe dosar (nr. / dată decizie). Lipsă = se păstrează ce era.
  credentials: z.record(z.string(), z.unknown()).optional(),
});

/** Valorile de completat: string-uri; `null` șterge cheia. */
const metadataPatchSchema = z.record(z.string().max(80), z.union([z.string().max(2000), z.null()]));

export const createDossierSchema = z.object({
  templateGroupId: z.string().cuid(),
  // Client existent sau unul nou, creat în aceeași tranzacție.
  client: z.union([z.object({ id: z.string().cuid() }), createClientSchema]),
  name: z.string().max(200).optional(),
  address: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  county: z.string().max(100).optional(),
  metadata: metadataPatchSchema.optional(),
});

// Salvare automată: orice câmp poate lipsi, iar cele de adresă pot fi goale cât timp
// omul încă scrie.
export const updateDossierSchema = z.object({
  templateGroupId: z.string().cuid().optional(),
  clientId: z.string().cuid().optional(),
  name: z.string().max(200).optional(),
  address: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  county: z.string().max(100).optional(),
  metadata: metadataPatchSchema.optional(),
  teamMembers: z.array(dossierTeamMemberSchema).max(40).optional(),
});

export const listDossiersQuerySchema = z.object({
  q: z.string().max(100).optional(),
  clientId: z.string().cuid().optional(),
  categoryCode: z.string().max(40).optional(),
});

export type CreateDossierInput = z.infer<typeof createDossierSchema>;
export type UpdateDossierInput = z.infer<typeof updateDossierSchema>;
export type DossierTeamMemberInput = z.infer<typeof dossierTeamMemberSchema>;
