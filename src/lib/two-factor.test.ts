import { describe, expect, it } from "vitest";
import {
  deviceLabel,
  generateBackupCodes,
  generateEmailCode,
  hashBackupCode,
  verifyBackupCode,
  hashEmailCode,
  maskEmail,
  normalizeBackupCode,
  safeEqualHex,
} from "./two-factor.js";

describe("maskEmail", () => {
  it.each([
    ["alex@gmail.com", "a***@gmail.com"],
    ["a@x.ro", "a***@x.ro"],
    ["Ion.Popescu@firma.ro", "I***@firma.ro"],
  ])("%s → %s", (email, masked) => {
    expect(maskEmail(email)).toBe(masked);
  });
});

describe("codul pe e-mail", () => {
  it("are 6 cifre (cu zerouri în față)", () => {
    for (let i = 0; i < 200; i++) expect(generateEmailCode()).toMatch(/^\d{6}$/);
  });
  it("hash-ul depinde de provocare (sare) și nu conține codul", () => {
    const a = hashEmailCode("ch1", "123456");
    expect(a).not.toContain("123456");
    expect(a).not.toBe(hashEmailCode("ch2", "123456"));
    expect(safeEqualHex(a, hashEmailCode("ch1", "123456"))).toBe(true);
    expect(safeEqualHex(a, hashEmailCode("ch1", "123457"))).toBe(false);
    expect(safeEqualHex(a, "abc")).toBe(false);
  });
});

describe("codurile de rezervă", () => {
  it("10 coduri unice, format xxxx-xxxx, litere mici și cifre", () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
  });
  it("normalizarea acceptă majuscule, spații și lipsa cratimei; restul → null", () => {
    expect(normalizeBackupCode(" AB2C-D3EF ")).toBe("ab2c-d3ef");
    expect(normalizeBackupCode("ab2cd3ef")).toBe("ab2c-d3ef");
    expect(normalizeBackupCode("123456")).toBeNull();
    expect(normalizeBackupCode("ab2c-d3e")).toBeNull();
  });
  it("hash-ul e argon2 (lent, ca parolele): o bază scăpată nu se sparge rapid; e legat de utilizator", async () => {
    const h = await hashBackupCode("u1", "ab2c-d3ef");
    expect(h.startsWith("$argon2")).toBe(true);
    expect(await verifyBackupCode(h, "u1", "ab2c-d3ef")).toBe(true);
    expect(await verifyBackupCode(h, "u2", "ab2c-d3ef")).toBe(false);
    expect(await verifyBackupCode(h, "u1", "ab2c-d3eg")).toBe(false);
  });
});

describe("deviceLabel", () => {
  it.each([
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", "Chrome pe macOS"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0", "Edge pe Windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox pe Windows"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", "Safari pe iPhone"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36", "Chrome pe Android"],
  ])("%s", (ua, label) => {
    expect(deviceLabel(ua)).toBe(label);
  });
  it("fără user-agent → „Browser necunoscut”", () => {
    expect(deviceLabel(undefined)).toBe("Browser necunoscut");
  });
});
