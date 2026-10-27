import { describe, expect, it } from "vitest";
import { isBlockedWrite } from "./impersonation.js";

describe("garda doar citire (impersonare)", () => {
  it("fără impersonare nu blochează nimic", () => {
    expect(isBlockedWrite("POST", "/api/clients", undefined)).toBe(false);
  });
  it("citirile trec, scrierile sunt blocate", () => {
    expect(isBlockedWrite("GET", "/api/clients", true)).toBe(false);
    expect(isBlockedWrite("HEAD", "/api/clients", true)).toBe(false);
    expect(isBlockedWrite("POST", "/api/clients", true)).toBe(true);
    expect(isBlockedWrite("PATCH", "/api/appointments/x", true)).toBe(true);
    expect(isBlockedWrite("DELETE", "/api/appointments/x", true)).toBe(true);
  });
  it("ieșirea din sesiune rămâne permisă (și cu query string)", () => {
    expect(isBlockedWrite("POST", "/api/admin/impersonation/end", true)).toBe(false);
    expect(isBlockedWrite("POST", "/api/auth/logout?x=1", true)).toBe(false);
  });
});
