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
  // Optional: derived from tenantName (and made unique) when omitted.
  tenantSlug: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens")
    .optional(),
  // Company details prefilled from ANAF on the register form (all optional).
  cui: z.string().trim().max(20).optional(),
  regCom: z.string().trim().max(40).optional(),
  address: z.string().trim().max(300).optional(),
  phone: z.string().trim().max(40).optional(),
  // Registered-office location matched against our geography (from the ANAF lookup).
  countryId: z.number().int().positive().optional(),
  stateId: z.number().int().positive().optional(),
  cityId: z.number().int().positive().optional(),
  email: z.string().email(),
  password: passwordPolicySchema,
  firstName: z.string().min(1).max(50),
  lastName: z.string().min(1).max(50),
});

/** Identity of the phone, sent by the mobile app at login (Android ID / iOS IDFV + model). */
export const mobileDeviceSchema = z.object({
  deviceId: z.string().min(8).max(128),
  platform: z.enum(["android", "ios"]).optional(),
  model: z.string().max(120).optional(),
  name: z.string().max(120).optional(),
  appVersion: z.string().max(40).optional(),
});
export type MobileDeviceInput = z.infer<typeof mobileDeviceSchema>;

export const loginSchema = z
  .object({
    email: z.string().email(),
    password: z.string(),
    // Omitted by the web app → "web". The mobile app sends "mobile" + device;
    // the server then checks User.mobileAccess and registers/validates the device.
    client: z.enum(["web", "mobile"]).default("web"),
    device: mobileDeviceSchema.optional(),
    // Web: tokenul „ține minte acest dispozitiv” (2FA) din localStorage; ignorat pe mobil.
    trustedDevice: z.string().max(200).optional(),
  })
  .refine((v) => v.client !== "mobile" || !!v.device, {
    message: "Aplicația mobilă trebuie să trimită identitatea dispozitivului",
    path: ["device"],
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

// Tokenul din linkul de confirmare a e-mailului: 32 de octeți aleatori, hex.
export const verifyEmailSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/, "Linkul de confirmare nu este valid"),
});

// ─── Autentificarea în doi pași ─────────────────────────────────────────────
const twoFactorCode = z.string().trim().min(6).max(20);

export const twoFactorVerifySchema = z.object({
  ticket: z.string().regex(/^[a-f0-9]{64}$/),
  code: twoFactorCode,
  rememberDevice: z.boolean().optional(),
});
export const twoFactorTicketSchema = z.object({ ticket: z.string().regex(/^[a-f0-9]{64}$/) });
export const twoFactorSetupSchema = z.object({ method: z.enum(["email", "totp"]) });
export const twoFactorConfirmSchema = z.object({
  code: twoFactorCode,
  password: z.string().min(1).max(200),
  // Sesiunea din care se face schimbarea rămâne deschisă (celelalte sesiuni web se închid).
  refreshToken: z.string().max(200).optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
