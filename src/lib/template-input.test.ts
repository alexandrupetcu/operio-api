import { describe, expect, it } from "vitest";
import { isReservedTemplateKey, sanitizeTemplateInput } from "./template-input.js";

describe("isReservedTemplateKey", () => {
  const reserved = [
    "tenant_name",
    "tenant_stamp",
    "tenant_signature",
    "tenant.logo",
    "rte_signature",
    "sudor_signature",
    "client_signature",
    "client_signature_date",
    "project_drawing",
    "nr_inregistrare",
    "nr_inregistrare_data",
    "data_inregistrare",
    "os_nr_inregistrare",
    "os_data_inregistrare",
  ];
  for (const k of reserved) {
    it(`„${k}" e rezervat`, () => expect(isReservedTemplateKey(k)).toBe(true));
  }

  const allowed = ["client_name", "adresa", "o2", "nr_contract", "signature_rte", "ostentativ", "tenanted"];
  for (const k of allowed) {
    it(`„${k}" nu e rezervat`, () => expect(isReservedTemplateKey(k)).toBe(false));
  }
});

describe("sanitizeTemplateInput", () => {
  it("scoate cheile pe care le calculează worker-ul", () => {
    const out = sanitizeTemplateInput({
      client_name: "Ion Popescu",
      tenant_name: "FIRMA ATACATORULUI SRL",
      tenant_stamp: "x",
      rte_signature: "x",
      client_signature: "x",
      project_drawing: "x",
      nr_inregistrare: "999/2026",
      nr_inregistrare_data: "01.01.2026",
      data_inregistrare: "01.01.2026",
      os_nr_inregistrare: "1",
      os_data_inregistrare: "1",
    });
    expect(out).toEqual({ client_name: "Ion Popescu" });
  });

  it("scoate orice valoare care arată a referință de imagine (`s3Key`), recursiv", () => {
    const out = sanitizeTemplateInput({
      ok: "da",
      logo: { s3Key: "alt_tenant/logo.png" },
      nested: { inner: { s3Key: "alt_tenant/stamp.png" }, keep: "1" },
      list: [{ s3Key: "alt_tenant/a.png" }, { name: "b" }, "text"],
    });
    expect(out).toEqual({
      ok: "da",
      nested: { keep: "1" },
      list: [{ name: "b" }, "text"],
    });
  });

  it("scoate cheile rezervate și la adâncime", () => {
    const out = sanitizeTemplateInput({
      pv: { materiale: [{ nume: "țeavă", tenant_name: "x", rte_signature: "y" }], nr_pv: "1", os_nr: "1" },
    });
    // `os_*` e rezervat (`/^os_/`), deci dispare și de la adâncime.
    expect(out).toEqual({ pv: { materiale: [{ nume: "țeavă" }], nr_pv: "1" } });
  });

  it("nu lasă `__proto__` / `constructor` / `prototype` în rezultat și nu poluează prototipul", () => {
    const payload = JSON.parse('{"__proto__": {"polluted": 1}, "constructor": 1, "prototype": 2, "ok": 3}');
    const out = sanitizeTemplateInput(payload);
    expect(out).toEqual({ ok: 3 });
    expect(Object.hasOwn(out, "__proto__")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("plafonează adâncimea la 8 niveluri", () => {
    // 10 niveluri: ultimele se taie, dar nimic nu aruncă.
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let i = 0; i < 12; i++) deep = { n: deep };
    expect(() => sanitizeTemplateInput(deep)).not.toThrow();
    let cur: Record<string, unknown> | undefined = sanitizeTemplateInput(deep);
    let levels = 0;
    while (cur && typeof cur.n === "object" && cur.n !== null) {
      cur = cur.n as Record<string, unknown>;
      levels++;
      if (levels > 30) break;
    }
    expect(levels).toBeLessThanOrEqual(12);
  });

  it("structurile recursive nu intră în buclă infinită", () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(() => sanitizeTemplateInput(a)).not.toThrow();
  });

  it("intrările care nu sunt obiect → {}", () => {
    expect(sanitizeTemplateInput(null)).toEqual({});
    expect(sanitizeTemplateInput(undefined)).toEqual({});
    expect(sanitizeTemplateInput("text")).toEqual({});
    expect(sanitizeTemplateInput(42)).toEqual({});
    expect(sanitizeTemplateInput([1, 2])).toEqual({});
  });

  it("nu modifică obiectul primit", () => {
    const input = { tenant_name: "x", ok: "1" };
    sanitizeTemplateInput(input);
    expect(input.tenant_name).toBe("x");
  });

  it("valorile primitive trec neschimbate (inclusiv null și false)", () => {
    expect(sanitizeTemplateInput({ a: null, b: false, c: 0, d: "" })).toEqual({ a: null, b: false, c: 0, d: "" });
  });
});
