import { generate, generateSecret, generateURI, verify } from "otplib";
import QRCode from "qrcode";

/**
 * TOTP (RFC 6238) pentru aplicațiile de autentificare (Google / Microsoft Authenticator
 * și orice altă aplicație standard): 6 cifre, pas de 30 s, SHA-1 — valorile implicite
 * pe care le înțeleg toate aplicațiile. Se acceptă pasul anterior și următorul (±30 s),
 * pentru ceasuri de telefon ușor decalate.
 */
export const TOTP_ISSUER = "Operio";
const PERIOD = 30;

/** Secret nou, 20 de octeți (160 de biți), în Base32. */
export function newTotpSecret(): string {
  return generateSecret({ length: 20 });
}

export function totpUri(secret: string, label: string): string {
  return generateURI({ issuer: TOTP_ISSUER, label, secret });
}

export async function totpQrDataUrl(uri: string): Promise<string> {
  return QRCode.toDataURL(uri, { errorCorrectionLevel: "M", margin: 1, width: 240 });
}

/** Codul curent (sau la momentul `epoch`, în secunde) — pentru teste și verificări locale. */
export async function totpCode(secret: string, epoch?: number): Promise<string> {
  return generate({ secret, ...(epoch !== undefined ? { epoch } : {}) });
}

/**
 * Verifică un cod. Întoarce pasul de timp folosit (de reținut, ca același cod să nu
 * poată fi refolosit — `afterTimeStep`) sau `null` dacă e greșit / malformat.
 */
export async function verifyTotp(
  secret: string,
  code: string,
  opts: { epoch?: number; afterTimeStep?: number } = {},
): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  try {
    const result = await verify({
      secret,
      token: code,
      epochTolerance: PERIOD,
      ...(opts.epoch !== undefined ? { epoch: opts.epoch } : {}),
      ...(opts.afterTimeStep !== undefined ? { afterTimeStep: opts.afterTimeStep } : {}),
    });
    return result.valid ? (result as { timeStep: number }).timeStep : null;
  } catch {
    return null;
  }
}
