import { z } from "zod";

const clientStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);

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
  name: z.string().min(1),
  fuel: z.string().optional(),
  serial: z.string().optional(),
});

export const createClientSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("COMPANY"),
    status: clientStatusSchema.optional(),
    companyName: z.string().min(1).max(200),
    cui: z.string().optional(),
    address: z.string().min(1),
    countryId: z.number().int().positive().optional().nullable(),
    stateId: z.number().int().positive().optional().nullable(),
    cityId: z.number().int().positive().optional().nullable(),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    contactPersons: z.array(contactPersonSchema).optional(),
    equipment: z.array(equipmentSchema).optional(),
  }),
  z.object({
    type: z.literal("PERSON"),
    status: clientStatusSchema.optional(),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    address: z.string().min(1),
    countryId: z.number().int().positive().optional().nullable(),
    stateId: z.number().int().positive().optional().nullable(),
    cityId: z.number().int().positive().optional().nullable(),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    equipment: z.array(equipmentSchema).optional(),
  }),
]);

export const updateClientSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("COMPANY"),
    status: clientStatusSchema.optional(),
    companyName: z.string().min(1).max(200).optional(),
    cui: z.string().optional(),
    address: z.string().min(1).optional(),
    countryId: z.number().int().positive().optional().nullable(),
    stateId: z.number().int().positive().optional().nullable(),
    cityId: z.number().int().positive().optional().nullable(),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    contactPersons: z.array(contactPersonSchema).optional(),
    equipment: z.array(equipmentSchema).optional(),
  }),
  z.object({
    type: z.literal("PERSON"),
    status: clientStatusSchema.optional(),
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
    address: z.string().min(1).optional(),
    countryId: z.number().int().positive().optional().nullable(),
    stateId: z.number().int().positive().optional().nullable(),
    cityId: z.number().int().positive().optional().nullable(),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    equipment: z.array(equipmentSchema).optional(),
  }),
]);

export type CreateClientInput = z.infer<typeof createClientSchema>;
export type UpdateClientInput = z.infer<typeof updateClientSchema>;
