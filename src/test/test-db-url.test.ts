import { describe, expect, it } from "vitest";
import { TestDatabaseError, databaseNameOf, resolveTestDbUrl, suggestTestDatabaseUrl } from "./test-db-url.js";

const OK = "postgresql://operio:secret@localhost:5433/operio_test";

describe("resolveTestDbUrl", () => {
  it("acceptă o bază care se termină cu _test", () => {
    const r = resolveTestDbUrl(OK);
    expect(r.database).toBe("operio_test");
    expect(r.url).toBe(OK);
    expect(r.maintenanceUrl).toBe("postgresql://operio:secret@localhost:5433/postgres");
  });

  it("REFUZĂ baza de dezvoltare `operio`", () => {
    expect(() => resolveTestDbUrl("postgresql://operio:secret@localhost:5433/operio")).toThrow(TestDatabaseError);
    expect(() => resolveTestDbUrl("postgresql://operio:secret@localhost:5433/operio")).toThrow(/REFUZ/);
  });

  it("REFUZĂ `postgres` și bazele de producție", () => {
    for (const db of ["postgres", "operio_prod", "operio_production"]) {
      expect(() => resolveTestDbUrl(`postgresql://u:p@h:5432/${db}`), db).toThrow(/REFUZ/);
    }
  });

  it("REFUZĂ orice nume care nu se termină cu _test", () => {
    expect(() => resolveTestDbUrl("postgresql://u:p@h:5432/testing")).toThrow(/_test/);
    expect(() => resolveTestDbUrl("postgresql://u:p@h:5432/operio_staging")).toThrow(/_test/);
  });

  it("respinge un URL invalid, o schemă greșită sau lipsa numelui bazei", () => {
    expect(() => resolveTestDbUrl("nu-e-url")).toThrow(/URL valid/);
    expect(() => resolveTestDbUrl("mysql://u:p@h/x_test")).toThrow(/postgresql/);
    expect(() => resolveTestDbUrl("postgresql://u:p@h:5432/")).toThrow(/numele bazei/);
  });

  it("acceptă și schema `postgres:` și parametrii din query", () => {
    const r = resolveTestDbUrl("postgres://u:p@h:5432/ci_test?schema=public&connection_limit=5");
    expect(r.database).toBe("ci_test");
    expect(r.maintenanceUrl).toBe("postgres://u:p@h:5432/postgres");
  });
});

describe("databaseNameOf", () => {
  it("scoate numele bazei", () => {
    expect(databaseNameOf(OK)).toBe("operio_test");
    expect(databaseNameOf("postgresql://u:p@h:5432/x_test?schema=public")).toBe("x_test");
  });
});

describe("suggestTestDatabaseUrl", () => {
  it("derivă sugestia din DATABASE_URL, păstrând utilizator/parolă/port", () => {
    expect(suggestTestDatabaseUrl("postgresql://operio:operio_dev@localhost:5433/operio")).toBe(
      "postgresql://operio:operio_dev@localhost:5433/operio_test",
    );
  });

  it("fără DATABASE_URL (sau cu una invalidă) dă un exemplu generic", () => {
    expect(suggestTestDatabaseUrl(undefined)).toContain("operio_test");
    expect(suggestTestDatabaseUrl("nu-e-url")).toContain("operio_test");
  });
});
