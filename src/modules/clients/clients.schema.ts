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
