import { describe, expect, it } from "vitest";
import { ALL_FEATURES, FEATURES, isFeature } from "./features.js";
import { DEFAULT_PLAN, PLANS, isPlanId } from "./plans.js";
import { resolveEntitlements, serializeEntitlements } from "./resolve.js";

const tenant = (over: Partial<{ plan: string; planUntil: Date | null; entitlementOverrides: unknown }> = {}) => ({
  plan: "execution",
  planUntil: null,
  entitlementOverrides: null,
  ...over,
});

describe("catalogul de planuri", () => {
  it("planul Teren NU include niciuna din funcțiile de execuție", () => {
    // Regula de business: „field" vinde doar terenul. Dacă o cheie de proiecte /
    // dosare / e-mail / builder ajunge aici, firmele pe planul ieftin capătă gratis
    // modulul scump — de aceea testul e pe tipar, nu pe o listă fixă.
    const forbidden = PLANS.field.features.filter(
      (f) =>
        f.startsWith("projects.") ||
        f === "documents.dossiers" ||
        f === "integrations.email" ||
        f === "admin.workflow-builder",
    );
    expect(forbidden).toEqual([]);
  });

  it("planul Teren conține exact funcțiile field.*", () => {
    expect([...PLANS.field.features].sort()).toEqual(ALL_FEATURES.filter((f) => f.startsWith("field.")).sort());
  });

  it("planul Execuție conține tot catalogul", () => {
    expect([...PLANS.execution.features].sort()).toEqual([...ALL_FEATURES].sort());
  });

  it("fiecare funcție din plan există în FEATURES", () => {
    for (const plan of Object.values(PLANS)) {
      for (const f of plan.features) expect(Object.hasOwn(FEATURES, f)).toBe(true);
    }
  });

  it("limitele de locuri: Teren 5, Execuție 10", () => {
    expect(PLANS.field.limits.technicianSeats).toBe(5);
    expect(PLANS.execution.limits.technicianSeats).toBe(10);
  });

  it("isPlanId / isFeature acceptă doar valori din catalog", () => {
    expect(isPlanId("field")).toBe(true);
    expect(isPlanId("execution")).toBe(true);
    expect(isPlanId("enterprise")).toBe(false);
    expect(isPlanId(null)).toBe(false);
    expect(isFeature("field.mobile")).toBe(true);
    expect(isFeature("field.unknown")).toBe(false);
    expect(isFeature("__proto__")).toBe(false);
    expect(isFeature("toString")).toBe(false);
  });

  it("DEFAULT_PLAN e un plan valid", () => {
    expect(isPlanId(DEFAULT_PLAN)).toBe(true);
  });
});

describe("resolveEntitlements — planuri", () => {
  it("planul Teren: are field.*, nu are projects.*", () => {
    const e = resolveEntitlements(tenant({ plan: "field" }));
    expect(e.plan).toBe("field");
    expect(e.planLabel).toBe("Teren");
    expect(e.has("field.mobile")).toBe(true);
    expect(e.has("field.os-registration")).toBe(true);
    expect(e.has("projects.workflows")).toBe(false);
    expect(e.has("documents.dossiers")).toBe(false);
    expect(e.has("integrations.email")).toBe(false);
    expect(e.has("admin.workflow-builder")).toBe(false);
    expect(e.limits.technicianSeats).toBe(5);
  });

  it("planul Execuție: are tot", () => {
    const e = resolveEntitlements(tenant({ plan: "execution" }));
    expect(e.plan).toBe("execution");
    expect(e.planLabel).toBe("Execuție");
    for (const f of ALL_FEATURES) expect(e.has(f), f).toBe(true);
    expect(e.limits.technicianSeats).toBe(10);
  });

  it("plan necunoscut / lipsă → planul implicit, fără să arunce", () => {
    for (const plan of ["", "enterprise", "FIELD", "__proto__"]) {
      const e = resolveEntitlements(tenant({ plan }));
      expect(e.plan).toBe(DEFAULT_PLAN);
    }
  });
});

describe("resolveEntitlements — ajustări per firmă", () => {
  it("add adaugă o funcție peste plan (add-on)", () => {
    const e = resolveEntitlements(
      tenant({ plan: "field", entitlementOverrides: { features: { add: ["documents.dossiers"] } } }),
    );
    expect(e.has("documents.dossiers")).toBe(true);
    expect(e.has("projects.workflows")).toBe(false);
    expect(e.features).toContain("documents.dossiers");
  });

  it("remove scoate o funcție din plan", () => {
    const e = resolveEntitlements(
      tenant({ plan: "execution", entitlementOverrides: { features: { remove: ["integrations.email"] } } }),
    );
    expect(e.has("integrations.email")).toBe(false);
    expect(e.has("projects.workflows")).toBe(true);
  });

  it("remove câștigă peste add pentru aceeași cheie", () => {
    const e = resolveEntitlements(
      tenant({
        plan: "field",
        entitlementOverrides: { features: { add: ["projects.drawings"], remove: ["projects.drawings"] } },
      }),
    );
    expect(e.has("projects.drawings")).toBe(false);
  });

  it("cheile inexistente din add/remove sunt ignorate în silență", () => {
    const e = resolveEntitlements(
      tenant({
        plan: "field",
        entitlementOverrides: { features: { add: ["nope", "__proto__", "constructor"], remove: ["nope"] } },
      }),
    );
    expect([...e.features].sort()).toEqual([...PLANS.field.features].sort());
    expect(e.has("field.mobile")).toBe(true);
  });

  it("limita de locuri se poate suprascrie per firmă (și în jos la 0)", () => {
    expect(resolveEntitlements(tenant({ plan: "field", entitlementOverrides: { limits: { technicianSeats: 25 } } })).limits
      .technicianSeats).toBe(25);
    expect(resolveEntitlements(tenant({ plan: "execution", entitlementOverrides: { limits: { technicianSeats: 1 } } })).limits
      .technicianSeats).toBe(1);
    expect(resolveEntitlements(tenant({ plan: "execution", entitlementOverrides: { limits: { technicianSeats: 0 } } })).limits
      .technicianSeats).toBe(0);
  });

  it("overrides invalide (schema strictă) → se ignoră tot, se păstrează planul", () => {
    for (const bad of [
      { features: { add: "documents.dossiers" } }, // nu e array
      { limits: { technicianSeats: -1 } }, // sub minim
      { limits: { technicianSeats: 1.5 } }, // nu e întreg
      { unknownKey: true }, // .strict()
      "not-an-object",
      42,
    ]) {
      const e = resolveEntitlements(tenant({ plan: "field", entitlementOverrides: bad }));
      expect([...e.features].sort()).toEqual([...PLANS.field.features].sort());
      expect(e.limits.technicianSeats).toBe(5);
    }
  });

  it("overrides null/undefined se tratează ca „fără ajustări”", () => {
    expect(resolveEntitlements(tenant({ entitlementOverrides: null })).limits.technicianSeats).toBe(10);
    expect(resolveEntitlements(tenant({ entitlementOverrides: undefined })).limits.technicianSeats).toBe(10);
  });
});

describe("resolveEntitlements — expirare", () => {
  it("planUntil în trecut → expired, dar funcțiile rămân (citirile trec)", () => {
    const e = resolveEntitlements(tenant({ planUntil: new Date(Date.now() - 86_400_000) }));
    expect(e.expired).toBe(true);
    expect(e.has("projects.workflows")).toBe(true);
  });

  it("planUntil în viitor → nu e expirat", () => {
    expect(resolveEntitlements(tenant({ planUntil: new Date(Date.now() + 86_400_000) })).expired).toBe(false);
  });

  it("planUntil null → abonament fără termen, niciodată expirat", () => {
    const e = resolveEntitlements(tenant({ planUntil: null }));
    expect(e.expired).toBe(false);
    expect(e.planUntil).toBeNull();
  });

  it("planUntil se serializează ISO", () => {
    const until = new Date("2027-01-31T10:00:00.000Z");
    expect(resolveEntitlements(tenant({ planUntil: until })).planUntil).toBe("2027-01-31T10:00:00.000Z");
  });
});

describe("serializeEntitlements", () => {
  it("scoate funcția has și păstrează restul câmpurilor", () => {
    const e = resolveEntitlements(tenant({ plan: "field", planUntil: new Date("2027-01-01T00:00:00.000Z") }));
    const dto = serializeEntitlements(e);
    expect(Object.keys(dto).sort()).toEqual(["expired", "features", "limits", "plan", "planLabel", "planUntil"]);
    expect("has" in dto).toBe(false);
    expect(dto).toEqual({
      plan: "field",
      planLabel: "Teren",
      planUntil: "2027-01-01T00:00:00.000Z",
      expired: false,
      features: e.features,
      limits: { technicianSeats: 5 },
    });
  });

  it("rezultatul e serializabil JSON (ajunge pe fir ca atare)", () => {
    const dto = serializeEntitlements(resolveEntitlements(tenant()));
    expect(JSON.parse(JSON.stringify(dto))).toEqual(dto);
  });
});
