import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Criptarea secretelor păstrate în baza de date (secretul TOTP al autentificării în
 * doi pași): AES-256-GCM, IV aleator de 12 octeți, tag de 16 octeți. Formatul stocat
 * e `v1:<base64(iv | tag | ciphertext)>`, ca o rotire viitoare a cheii să poată
 * recunoaște versiunea. Cheia (32 de octeți, base64) vine din `TWO_FACTOR_KEY` și
 * nu intră niciodată în git — un dump al bazei fără cheie nu dă secretele.
 */
const VERSION = "v1:";

/** Cheia din env: lipsă / gol → null; altă lungime decât 32 de octeți → eroare. */
export function parseSecretKey(raw: string | undefined | null): Buffer | null {
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("TWO_FACTOR_KEY trebuie să fie 32 de octeți codați base64");
  return key;
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return VERSION + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decryptSecret(stored: string, key: Buffer): string {
  if (!stored.startsWith(VERSION)) throw new Error("Format de secret necunoscut");
  const raw = Buffer.from(stored.slice(VERSION.length), "base64");
  if (raw.length < 29) throw new Error("Secret criptat invalid");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}
