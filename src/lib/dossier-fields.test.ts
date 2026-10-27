import { describe, expect, it } from "vitest";
import { dossierCompletion, fieldsForPlaceholders, placeholdersIn, unitFor, fieldForKey, withAliases } from "./dossier-fields.js";

describe("dossier fields", () => {
  it("extracts placeholders including loops and images", () => {
    expect([...placeholdersIn("Nr {cod_atr} {#project_sudori}{nr_crt}{/project_sudori} {%tenant_logo}")]).toEqual([
      "cod_atr", "#project_sudori", "nr_crt", "/project_sudori", "%tenant_logo",
    ]);
  });

  it("keeps only registry fields used by the group, maps roles and unknowns", () => {
    const plan = fieldsForPlaceholders([
      { name: "PV PIF", placeholders: new Set(["cod_atr", "tenant_name", "client_name", "rte_nume", "rte_decizie_nr", "%rte_signature"]) },
      { name: "Opis", placeholders: new Set(["proiect_nr_documentatie", "#project_sudori", "nr_crt", "/project_sudori", "%project_drawing", "camp_firma"]) },
    ]);
    expect(plan.fields.map((f) => f.field.key)).toEqual(["cod_atr", "proiect_nr", "camp_firma"]);
    expect(plan.fields[1].docs).toEqual(["Opis"]);
    expect(plan.fields[2].field.section).toBe("Alte câmpuri");
    expect(plan.roles).toEqual([
      { role: "rte", docs: ["PV PIF"], assignmentFields: ["decizie_nr"] },
      { role: "sudor", docs: ["Opis"], assignmentFields: [] },
    ]);
    expect(plan.needsDrawing).toBe(true);
    expect(plan.usesSudoriTable).toBe(true);
  });

  it("pressure unit depends on category", () => {
    const f = fieldForKey("proba_rezistenta_presiune")!;
    expect(unitFor(f, "DOSAR_ISCIR")).toBe("bar");
    expect(unitFor(f, "CARTE_BRANSAMENT")).toBe("Pa");
  });

  it("writes values under aliases both ways without overwriting", () => {
    expect(withAliases({ proiect_nr: "12" })).toMatchObject({ proiect_nr: "12", proiect_nr_documentatie: "12" });
    expect(withAliases({ schema_izometrica_nr: "S1" })).toMatchObject({ nr_schema_izometrica: "S1" });
    expect(withAliases({ proiect_nr: "1", proiect_nr_documentatie: "2" })).toMatchObject({ proiect_nr_documentatie: "2" });
  });

  it("computes completion over fields and roles", () => {
    const plan = fieldsForPlaceholders([{ name: "A", placeholders: new Set(["cod_atr", "cod_sap", "rte_nume"]) }]);
    const c = dossierCompletion(plan, { cod_atr: "x", cod_sap: " " }, new Set());
    expect(c.filled).toBe(1);
    expect(c.total).toBe(3);
    expect(c.missing.map((m) => m.key)).toEqual(["cod_sap", "role:rte"]);
  });
});

describe("dossier fields — dosarele de branșament (contract 28.10)", () => {
  it("tabelul de suduri cere „Sudurile executate”; coloanele lui și totalul se completează singure", () => {
    const plan = fieldsForPlaceholders([
      { name: "Tabel suduri", placeholders: new Set(["#suduri", "nr_crt", "cod", "rezultat", "/suduri", "total_suduri"]) },
    ]);
    expect(plan.fields.map((f) => f.field.key)).toEqual(["suduri_lista"]);
    expect(plan.fields[0].docs).toEqual(["Tabel suduri"]);
  });

  it("RTS e rol de echipă; câmpurile noi au secțiuni și tipuri", () => {
    const plan = fieldsForPlaceholders([{ name: "PV sudură", placeholders: new Set(["rts_nume", "rts_atestat_data", "%rts_signature"]) }]);
    expect(plan.roles.map((r) => r.role)).toEqual(["rts"]);
    expect(plan.fields).toEqual([]);
    expect(fieldForKey("documente_materiale")?.type).toBe("textarea");
    expect(fieldForKey("bransament_lungime_totala")?.section).toBe("Conducta");
    expect(fieldForKey("osd_telefon")?.section).toBe("Distribuitorul (OSD)");
  });

  it("lungimea totală calculată nu apare ca lipsă", () => {
    const plan = fieldsForPlaceholders([{ name: "Cartea tehnică", placeholders: new Set(["bransament_lungime_totala"]) }]);
    const c = dossierCompletion(plan, { project_length: "2", bransament_lungime_reiser: "1.3" }, new Set());
    expect(c.missing).toEqual([]);
  });
});
