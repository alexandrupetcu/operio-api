import { z } from "zod";

const kindEnum = z.enum(["revision", "fleet", "task", "project"]);

export const snoozeActionSchema = z.object({
  actionKey: z.string().min(1).max(200),
  kind: kindEnum,
  conditionRef: z.string().min(1).max(300),
  until: z
    .string()
    .datetime()
    .refine((s) => new Date(s) > new Date(), "until must be in the future"),
  reason: z.string().max(500).optional(),
  note: z.string().max(2000).optional(),
});

export const dismissActionSchema = snoozeActionSchema.omit({ until: true });

export const unsnoozeActionSchema = z.object({
  actionKey: z.string().min(1).max(200),
  // Operator must explain why they're reactivating an item snoozed earlier
  // (often by a teammate) — keeps the team-shared audit trail honest.
  note: z.string().min(3).max(2000),
});

export type SnoozeActionInput = z.infer<typeof snoozeActionSchema>;
export type DismissActionInput = z.infer<typeof dismissActionSchema>;
