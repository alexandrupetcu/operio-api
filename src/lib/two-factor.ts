import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { hashPassword, verifyPassword } from "./hash.js";

/**
 * Bucățile pure ale autentificării în doi pași (fără bază de date): codurile pe
 * e-mail, codurile de rezervă, mascarea adresei și eticheta dispozitivului.
 */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** „alex@gmail.com” → „a***@gmail.com” — arătat pe ecranul de cod, fără adresa întreagă. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/** Cod de 6 cifre, uniform (crypto.randomInt), cu zerouri în față. */
export function generateEmailCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Codul pe e-mail se păstrează ca SHA-256, cu id-ul provocării ca sare. */
export function hashEmailCode(challengeId: string, code: string): string {
  return sha256(`${challengeId}:${code}`);
}

/** Comparație în timp constant a două hash-uri hex. */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

// Fără caractere ușor de confundat la transcriere (0/o, 1/l/i).
const BACKUP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const BACKUP_CODE_COUNT = 10;

function backupCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += BACKUP_ALPHABET[randomInt(0, BACKUP_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** 10 coduri de rezervă unice, format `xxxx-xxxx`, afișate o singură dată. */
export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(backupCode());
  return [...codes];
}

/** Ce a tastat omul → forma canonică `xxxx-xxxx`, sau null dacă nu arată a cod de rezervă. */
export function normalizeBackupCode(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/[\s-]/g, "");
  if (!/^[a-z0-9]{8}$/.test(s) || /^\d+$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/**
 * Codurile de rezervă au ~40 de biți: cu un hash rapid, o bază de date scăpată s-ar sparge
 * offline în câteva ore — de aceea argon2, ca parolele (verificarea: ≤10 coduri, rar folosită).
 */
export function hashBackupCode(userId: string, code: string): Promise<string> {
  return hashPassword(`${userId}:${code}`);
}

export async function verifyBackupCode(hash: string, userId: string, code: string): Promise<boolean> {
  try {
    return await verifyPassword(hash, `${userId}:${code}`);
  } catch {
    return false;
  }
}

/** „Chrome pe macOS” din user-agent — eticheta dispozitivului ținut minte. */
export function deviceLabel(ua: string | undefined | null): string {
  if (!ua) return "Browser necunoscut";
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\/|FxiOS\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser";
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Windows/.test(ua)
          ? "Windows"
          : /Mac OS X|Macintosh/.test(ua)
            ? "macOS"
            : /Linux/.test(ua)
              ? "Linux"
              : null;
  return os ? `${browser} pe ${os}` : browser;
}
