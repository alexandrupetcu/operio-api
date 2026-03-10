import { z } from "zod";

const clientStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);

const contactPersonSchema = z.object({
  id: z.string().optional(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().email().optional(),
});

export const createClientSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("COMPANY"),
    status: clientStatusSchema.optional(),
    companyName: z.string().min(1).max(200),
    cui: z.string().optional(),
    address: z.string().min(1),
    city: z.string().min(1),
    county: z.string().min(1),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    contactPersons: z.array(contactPersonSchema).optional(),
  }),
  z.object({
    type: z.literal("PERSON"),
    status: clientStatusSchema.optional(),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    address: z.string().min(1),
    city: z.string().min(1),
    county: z.string().min(1),
    phone: z.string().optional(),
    email: z.string().email().optional(),
  }),
]);

export const updateClientSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("COMPANY"),
    status: clientStatusSchema.optional(),
    companyName: z.string().min(1).max(200).optional(),
    cui: z.string().optional(),
    address: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
    county: z.string().min(1).optional(),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    contactPersons: z.array(contactPersonSchema).optional(),
  }),
  z.object({
    type: z.literal("PERSON"),
    status: clientStatusSchema.optional(),
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
    address: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
    county: z.string().min(1).optional(),
    phone: z.string().optional(),
    email: z.string().email().optional(),
  }),
]);

export type CreateClientInput = z.infer<typeof createClientSchema>;
export type UpdateClientInput = z.infer<typeof updateClientSchema>;
