import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertTenantKey, isTenantKey } from "./s3-guard.js";

const A = "tenant_aaa";
const B = "tenant_bbb";

describe("isTenantKey", () => {
  it("acceptă o cheie din prefixul firmei", () => {
    expect(isTenantKey(A, `${A}/projects/p1/doc.pdf`)).toBe(true);
    expect(isTenantKey(A, `${A}/x`)).toBe(true);
  });

  it("respinge cheia altei firme", () => {
    expect(isTenantKey(A, `${B}/projects/p1/doc.pdf`)).toBe(false);
    expect(isTenantKey(A, "stamps/global.png")).toBe(false);
  });

  it("respinge un prefix care doar începe la fel (fără `/`)", () => {
    expect(isTenantKey(A, `${A}x/doc.pdf`)).toBe(false);
    expect(isTenantKey(A, A)).toBe(false);
  });

  it("respinge traversarea de cale în orice poziție", () => {
    expect(isTenantKey(A, `${A}/../${B}/doc.pdf`)).toBe(false);
    expect(isTenantKey(A, `${A}/a/../../b.pdf`)).toBe(false);
    expect(isTenantKey(A, `${A}/./doc.pdf`)).toBe(false);
    expect(isTenantKey(A, `${A}/..`)).toBe(false);
  });

  it("respinge segmentele goale (dublu slash, slash final)", () => {
    expect(isTenantKey(A, `${A}//doc.pdf`)).toBe(false);
    expect(isTenantKey(A, `${A}/doc.pdf/`)).toBe(false);
    expect(isTenantKey(A, `${A}/`)).toBe(false);
  });

  it("respinge ce nu e text", () => {
    for (const v of [null, undefined, 42, {}, [], { s3Key: `${A}/x` }, true]) {
      expect(isTenantKey(A, v)).toBe(false);
    }
  });

  it("respinge un tenantId gol (altfel orice cheie ar trece)", () => {
    expect(isTenantKey("", "/doc.pdf")).toBe(false);
    expect(isTenantKey("", "doc.pdf")).toBe(false);
  });
});

describe("assertTenantKey", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("true, fără avertisment, pentru o cheie proprie", () => {
    expect(assertTenantKey(A, `${A}/stamp.png`, "ștampilă")).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("false + avertisment care numește activul și firma", () => {
    expect(assertTenantKey(A, `${B}/stamp.png`, "ștampilă")).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain("[s3-guard]");
    expect(msg).toContain("ștampilă");
    expect(msg).toContain(A);
  });

  it("eticheta implicită e „asset”", () => {
    assertTenantKey(A, `${B}/x.png`);
    expect(String(warn.mock.calls[0][0])).toContain("asset");
  });

  it("nu aruncă niciodată — randarea continuă fără activ", () => {
    expect(() => assertTenantKey(A, undefined)).not.toThrow();
    expect(assertTenantKey(A, undefined)).toBe(false);
  });
});
