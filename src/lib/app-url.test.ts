import { describe, expect, it } from "vitest";
import { appUrl } from "./app-url.js";

describe("appUrl — linkurile din e-mailuri", () => {
  it("o cale din aplicație primește adresa aplicației", () => {
    expect(appUrl("/projects/p1", "https://app.operio.ro")).toBe("https://app.operio.ro/projects/p1");
    expect(appUrl("/calendar?appt=a1&date=2026-11-19", "https://app.operio.ro/")).toBe("https://app.operio.ro/calendar?appt=a1&date=2026-11-19");
  });
  it("„/dashboard” (nu există ca rută) duce la panoul principal", () => {
    expect(appUrl("/dashboard", "https://app.operio.ro")).toBe("https://app.operio.ro/");
  });
  it("un link complet rămâne cum e", () => {
    expect(appUrl("https://operio.ro/ro/", "https://app.operio.ro")).toBe("https://operio.ro/ro/");
  });
});
