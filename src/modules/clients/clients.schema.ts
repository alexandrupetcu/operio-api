import { z } from "zod";

const clientStatusSchema = z.enum(["PROSPECT", "ACTIVE", "INACTIVE"]);

const contactPersonSchema = z.object({
  id: z.string().optional(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().email().optional(),
});

const equipmentSchema = z.object({
  id: z.string().optional(),
  type: z.enum(["CENTRALA"]).default("CENTRALA"),
  internalName: z.string().min(1),
  fuel: z.string().optional(),
  serial: z.string().optional(),
  clientAddressId: z.string().optional().nullable(),
});

export const equipmentInputSchema = z.object({
  type: z.enum(["CENTRALA"]).default("CENTRALA"),
  internalName: z.string().min(1),
  fuel: z.string().optional(),
  serial: z.string().optional(),
  clientAddressId: z.string().optional().nullable(),
});

// Consumer appliance on a gas installation (FISA "aparate consumatoare").
export const applianceSchema = z.object({
  kind: z.enum(["CT", "MA"]).default("CT"), // CT = centrală termică, MA = mașină aragaz
  name: z.string().optional().nullable(),
  debit: z.string().optional().nullable(), // debit nominal (mc/h), ex. "2.50"
  count: z.number().int().positive().optional().nullable(),
});

// Gas installation (instalație de utilizare) — reusable identity for
// revizie/verificare appointments. All fields optional (filled progressively).
export const gasInstallationInputSchema = z.object({
  label: z.string().optional().nullable(),
  clientAddressId: z.string().optional().nullable(),
  distributorName: z.string().optional().nullable(),
  codTehnicPOD: z.string().optional().nullable(),
  codClient: z.string().optional().nullable(),
  contractNumber: z.string().optional().nullable(),
  contractDate: z.string().optional().nullable(),
  documentatieNr: z.string().optional().nullable(),
  documentatieData: z.string().optional().nullable(),
  contorTip: z.string().optional().nullable(),
  contorSeria: z.string().optional().nullable(),
  contorNr: z.string().optional().nullable(),
  contorAn: z.string().optional().nullable(),
  contorIndex: z.string().optional().nullable(),
  appliances: z.array(applianceSchema).optional(),
});
export type GasInstallationInput = z.infer<typeof gasInstallationInputSchema>;

const clientAddressSchema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  address: z.string().min(1),
  countryId: z.number().int().positive().optional().nullable(),
  stateId: z.number().int().positive().optional().nullable(),
  cityId: z.number().int().positive().optional().nullable(),
  isPrimary: z.boolean().default(false),
});

export const clientAddressInputSchema = z.object({
  label: z.string().optional(),
  address: z.string().min(1),
  countryId: z.number().int().positive().optional().nullable(),
  stateId: z.number().int().positive().optional().nullable(),
  cityId: z.number().int().positive().optional().nullable(),
  isPrimary: z.boolean().default(false),
});

export const createClientSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("COMPANY"),
    status: clientStatusSchema.optional(),
    companyName: z.string().min(1).max(200),
    cui: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    contactPersons: z.array(contactPersonSchema).optional(),
    equipment: z.array(equipmentSchema).optional(),
    addresses: z.array(clientAddressSchema).min(1),
  }),
  z.object({
    type: z.literal("PERSON"),
    status: clientStatusSchema.optional(),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    equipment: z.array(equipmentSchema).optional(),
    addresses: z.array(clientAddressSchema).min(1),
  }),
]);

export const updateClientSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("COMPANY"),
    status: clientStatusSchema.optional(),
    companyName: z.string().min(1).max(200).optional(),
    cui: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    contactPersons: z.array(contactPersonSchema).optional(),
    equipment: z.array(equipmentSchema).optional(),
    addresses: z.array(clientAddressSchema).optional(),
  }),
  z.object({
    type: z.literal("PERSON"),
    status: clientStatusSchema.optional(),
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    equipment: z.array(equipmentSchema).optional(),
    addresses: z.array(clientAddressSchema).optional(),
  }),
]);

export type CreateClientInput = z.infer<typeof createClientSchema>;
export type UpdateClientInput = z.infer<typeof updateClientSchema>;

// ── Quick-dossier (client-level rapid generation, hidden Project) ──
// One row per dossier the user fills out + generates. The Project that backs
// it is created with kind="quick_dossier" so it stays out of the regular
// Projects list. Team-member rows live in ProjectTeamMember (same as full
// projects), so signature/credentials pipeline in the worker just works.

const dossierTeamMemberSchema = z.object({
  role: z.enum([
    "instalator", "proiectant", "rte", "sef_santier",
    "cq", "diriginte", "verificator", "sudor",
  ]),
  employeeId: z.string().cuid().optional().nullable(),
  // Free-form per-team-member credentials override (autorizatie nr/data,
  // legitimatie, etc.). Empty = inherit from Employee.credentials.
  credentials: z.record(z.string(), z.unknown()).optional(),
});

export const quickDossierInputSchema = z.object({
  // Which template group to render (must be type:"group", category in
  // CARTE_BRANSAMENT / CARTE_CONDUCTA / DOSAR_ISCIR).
  templateGroupId: z.string().cuid(),
  // Display name shown on the card + as project_name placeholder. Defaults
  // server-side to "Dosar <group name> — <client name>" when not provided.
  name: z.string().min(1).max(200).optional(),
  // Project address (project_address placeholder). Defaults to client's
  // primary address if omitted, but explicit override is supported.
  address: z.string().min(1).max(200),
  city: z.string().min(1).max(100),
  county: z.string().min(1).max(100),
  // Free-form metadata: any key here becomes a `{key}` placeholder in the
  // generated docx (the worker spreads project.metadata into the data dict).
  // Typically includes: project_dn, project_material, project_length,
  // ordin_lucru, cod_atr, autorizatie_construire_nr/data, osd_*, etc.
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Team roles for signature blocks + role-name placeholders.
  teamMembers: z.array(dossierTeamMemberSchema).optional(),
});

export const updateQuickDossierSchema = quickDossierInputSchema.partial();

export type QuickDossierInput = z.infer<typeof quickDossierInputSchema>;
export type UpdateQuickDossierInput = z.infer<typeof updateQuickDossierSchema>;
export type DossierTeamMemberInput = z.infer<typeof dossierTeamMemberSchema>;
