import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, parseSecretKey } from "./crypto-secret.js";

const key = randomBytes(32);

describe("encryptSecret / decryptSecret (AES-256-GCM)", () => {
  it("dus-întors dă textul inițial", () => {
    const enc = encryptSecret("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", key);
    expect(decryptSecret(enc, key)).toBe("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
  });

  it("nu păstrează secretul în clar și folosește un IV nou la fiecare criptare", () => {
    const a = encryptSecret("secret-totp", key);
    const b = encryptSecret("secret-totp", key);
    expect(a).not.toContain("secret-totp");
    expect(a).toMatch(/^v1:/);
    expect(a).not.toBe(b);
  });

  it("o cheie greșită sau un text modificat sunt respinse (autentificare GCM)", () => {
    const enc = encryptSecret("secret-totp", key);
    expect(() => decryptSecret(enc, randomBytes(32))).toThrow();
    const raw = Buffer.from(enc.slice(3), "base64");
    raw[raw.length - 1] ^= 1;
    expect(() => decryptSecret(`v1:${raw.toString("base64")}`, key)).toThrow();
  });

  it("formatul necunoscut e respins", () => {
    expect(() => decryptSecret("abc", key)).toThrow();
  });
});

describe("parseSecretKey", () => {
  it("acceptă exact 32 de octeți în base64", () => {
    expect(parseSecretKey(key.toString("base64"))?.equals(key)).toBe(true);
  });
  it("lipsă / gol → null", () => {
    expect(parseSecretKey(undefined)).toBeNull();
    expect(parseSecretKey("")).toBeNull();
  });
  it("lungimea greșită aruncă", () => {
    expect(() => parseSecretKey(randomBytes(16).toString("base64"))).toThrow();
  });
});
