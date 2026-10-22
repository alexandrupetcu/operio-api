import { z } from "zod";
import { raportCompletBranch } from "../appointments/appointments.schema.js";

/** Tipurile de programare care sunt „revizii”: centrală (ISCIR) și instalație (revizie / verificare). */
export const REVISION_TYPES = ["revizie", "revizie_instalatie", "verificare_instalatie"] as const;
export type RevisionType = (typeof REVISION_TYPES)[number];

export const listRevisionsQuerySchema = z.object({
  kind: z.enum(["centrala", "instalatie"]).optional(),
  type: z.enum(REVISION_TYPES).optional(),
  /** Implicit doar cele făcute; `scheduled` = cele încă de făcut; `all` = tot. */
  status: z.enum(["completed", "scheduled", "all"]).default("completed"),
  /** Beneficiar, adresă, POD / cod client, echipament. */
  q: z.string().trim().max(100).optional(),
  clientId: z.string().cuid().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListRevisionsQuery = z.infer<typeof listRevisionsQuerySchema>;

/**
 * Revizie făcută fără programare prealabilă: programarea se creează pe data reviziei
 * și se finalizează pe loc cu același raport ca din teren.
 */
export const createDirectRevisionSchema = z.object({
  type: z.enum(REVISION_TYPES),
  clientId: z.string().cuid(),
  clientAddressId: z.string().cuid().optional().nullable(),
  employeeId: z.string().cuid().optional().nullable(),
  equipmentId: z.string().cuid().optional().nullable(),
  installationId: z.string().cuid().optional().nullable(),
  date: z.string().datetime(),
  report: raportCompletBranch,
});
export type CreateDirectRevisionInput = z.infer<typeof createDirectRevisionSchema>;
