import { z } from "zod";

/**
 * Vocabularele care acceptă presetări. Lista e închisă intenționat: fără ea,
 * orice client ar putea semăna chei noi în tabelă și catalogul ar deveni un
 * depozit de gunoi.
 */
export const PRESET_SCOPES = [
  "material",
  "furnizor",
  "diamTeava",
  "diamArm",
  "contorTip",
  "certificat",
  "aparat",
] as const;

export type PresetScope = (typeof PRESET_SCOPES)[number];

const presetItemSchema = z.object({
  scope: z.enum(PRESET_SCOPES),
  value: z.string().min(1).max(120),
});

/** Acceptă o singură valoare sau un lot (formularul le raportează la finalizare). */
export const recordPresetsSchema = z.union([
  presetItemSchema,
  z.object({ items: z.array(presetItemSchema).max(100) }),
]);

export type RecordPresetsInput = z.infer<typeof recordPresetsSchema>;

export const renamePresetSchema = z.object({
  value: z.string().min(1).max(120),
});
