import { afterAll, describe, expect, it } from "vitest";
import { closeStub, serviceStub } from "../../test/stub.js";
import { refreshExpiryFor } from "./auth.service.js";
import { env } from "../../config/env.js";

/**
 * Sesiunile mobile trăiesc mai mult decât cele web (telefon legat de cont, blocare
 * biometrică în aplicație): refresh token-ul mobil expiră după `JWT_REFRESH_EXPIRY_MOBILE`.
 */
afterAll(async () => {
  await closeStub();
});

describe("durata sesiunii după client", () => {
  it("web → JWT_REFRESH_EXPIRY (7 zile implicit); mobil → JWT_REFRESH_EXPIRY_MOBILE (30 de zile implicit)", async () => {
    await serviceStub();
    expect(refreshExpiryFor("web")).toBe(env.JWT_REFRESH_EXPIRY);
    expect(refreshExpiryFor("mobile")).toBe(env.JWT_REFRESH_EXPIRY_MOBILE);
    expect(env.JWT_REFRESH_EXPIRY_MOBILE).toMatch(/^\d+[smhd]$/);
  });
});
