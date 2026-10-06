import { z } from "zod";

/**
 * Shared password policy used on register, change-password, and reset-password.
 * Minimum 8 chars and at least 3 of 4 character classes (upper / lower /
 * digit / special). We don't enforce all 4 — it nudges users toward predictable
 * patterns like "Password1!" — but 3-of-4 catches the worst (`alllowercase`,
 * `Capitalized`, `12345678`, etc.). For more rigor, consider zxcvbn later.
 */
export const passwordPolicySchema = z
  .string()
  .min(8, "Parola trebuie să aibă cel puțin 8 caractere")
  .max(200)
  .refine((p) => {
    let classes = 0;
    if (/[a-z]/.test(p)) classes++;
    if (/[A-Z]/.test(p)) classes++;
    if (/[0-9]/.test(p)) classes++;
    if (/[^a-zA-Z0-9]/.test(p)) classes++;
    return classes >= 3;
  }, "Parola trebuie să combine cel puțin 3 din: litere mici, litere mari, cifre, simboluri");

export const registerSchema = z.object({
  tenantName: z.string().min(2).max(100),
  tenantSlug: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens"),
  email: z.string().email(),
  password: passwordPolicySchema,
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

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordPolicySchema,
});

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(32).max(200),
  newPassword: passwordPolicySchema,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
