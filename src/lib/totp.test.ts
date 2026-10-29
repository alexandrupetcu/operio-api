import { describe, expect, it } from "vitest";
import { newTotpSecret, totpCode, totpQrDataUrl, totpUri, verifyTotp } from "./totp.js";

// RFC 6238, anexa B: secretul ASCII „12345678901234567890” (SHA-1), în Base32.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("TOTP (RFC 6238, 6 cifre, 30 s, SHA-1)", () => {
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("la T=%i codul este %s (ultimele 6 cifre din vectorul RFC)", async (epoch, code) => {
    expect(await totpCode(RFC_SECRET, epoch)).toBe(code);
    expect(await verifyTotp(RFC_SECRET, code, { epoch })).not.toBeNull();
  });

  it("acceptă pasul anterior și următorul (fereastră ±1), dar nu mai departe", async () => {
    const epoch = 1111111109;
    const prev = await totpCode(RFC_SECRET, epoch - 30);
    const next = await totpCode(RFC_SECRET, epoch + 30);
    const far = await totpCode(RFC_SECRET, epoch - 90);
    expect(await verifyTotp(RFC_SECRET, prev, { epoch })).not.toBeNull();
    expect(await verifyTotp(RFC_SECRET, next, { epoch })).not.toBeNull();
    expect(await verifyTotp(RFC_SECRET, far, { epoch })).toBeNull();
  });

  it("întoarce pasul de timp, iar un pas deja folosit e respins (anti-replay)", async () => {
    const epoch = 1111111109;
    const code = await totpCode(RFC_SECRET, epoch);
    const step = await verifyTotp(RFC_SECRET, code, { epoch });
    expect(step).toBe(Math.floor(epoch / 30));
    expect(await verifyTotp(RFC_SECRET, code, { epoch, afterTimeStep: step! })).toBeNull();
  });

  it("codurile malformate sunt respinse fără excepție", async () => {
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 56x"]) {
      expect(await verifyTotp(RFC_SECRET, bad)).toBeNull();
    }
  });

  it("secretul nou are 160 de biți (32 de caractere Base32) și e diferit de fiecare dată", () => {
    const a = newTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(newTotpSecret()).not.toBe(a);
  });

  it("URI-ul otpauth poartă emitentul Operio și e-mailul", () => {
    const uri = totpUri(RFC_SECRET, "ana@firma.ro");
    expect(uri).toMatch(/^otpauth:\/\/totp\/Operio:ana(%40|@)firma\.ro\?/);
    expect(uri).toContain(`secret=${RFC_SECRET}`);
    expect(uri).toContain("issuer=Operio");
  });

  it("codul QR e un data-URL PNG", async () => {
    expect(await totpQrDataUrl(totpUri(RFC_SECRET, "ana@firma.ro"))).toMatch(/^data:image\/png;base64,/);
  });
});
