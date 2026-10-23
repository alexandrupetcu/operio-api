import { z } from "zod";

// JWT secrets: 32+ chars in production (HS256 key should be ≥ 256 bits);
// relaxed to 10 in dev/test so the local `.env` keeps working.
const secretMin = process.env.NODE_ENV === "production" ? 32 : 10;

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  JWT_SECRET: z.string().min(secretMin),
  JWT_REFRESH_SECRET: z.string().min(secretMin),
  JWT_ACCESS_EXPIRY: z.string().default("15m"),
  JWT_REFRESH_EXPIRY: z.string().default("7d"),
  // Sesiunile mobile: telefonul e legat de cont și poate fi blocat cu Face ID / amprentă,
  // deci parola se cere mai rar decât pe web.
  JWT_REFRESH_EXPIRY_MOBILE: z.string().default("30d"),

  S3_ENDPOINT: z.string().url().optional(),
  S3_ACCESS_KEY: z.string(),
  S3_SECRET_KEY: z.string(),
  S3_BUCKET: z.string().default("operio-documents"),
  S3_REGION: z.string().default("us-east-1"),

  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  FRONTEND_URL: z.string().url().default("http://localhost:5173"),

  OPENAI_API_KEY: z.string().optional(),
  // Modelele (vezi lib/openai-models.ts): documente scanate vs. text. Se pot schimba fără deploy.
  OPENAI_MODEL_VISION: z.string().default("gpt-5.4"),
  OPENAI_MODEL_TEXT: z.string().default("gpt-5.4-mini"),

  // SMTP (optional — signing invitations)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default("noreply@operio.app"),
  // Reply-To on automated mail (noreply@ sender) so client replies reach a real inbox.
  SMTP_REPLY_TO: z.string().optional(),
  // Where demo requests from the marketing site land.
  CONTACT_EMAIL: z.string().email().default("alexandru.petcu@outlook.com"),

  // Gmail OAuth2 (optional — email ingestion)
  GMAIL_CLIENT_ID: z.string().optional(),
  GMAIL_CLIENT_SECRET: z.string().optional(),

  // Web Push (VAPID) — browser notifications. Generate once with
  // `npx web-push generate-vapid-keys` and keep the pair STABLE across deploys.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:noreply@operio.app"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid environment variables:");
    console.error(result.error.flatten().fieldErrors);
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
