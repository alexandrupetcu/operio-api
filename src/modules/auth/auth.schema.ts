import { z } from "zod";

export const registerSchema = z.object({
  tenantName: z.string().min(2).max(100),
  tenantSlug: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens"),
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1).max(50),
  lastName: z.string().min(1).max(50),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const refreshSchema = z.object({
  refreshToken: z.string(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
