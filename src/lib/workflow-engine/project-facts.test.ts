import { describe, expect, it } from "vitest";
import { projectFacts } from "./project-facts.js";

describe("projectFacts — ce văd condițiile workflow-ului despre proiect", () => {
  it("expune codurile tipului și distribuitorului (un workflow general nu poate compara id-urile unei firme)", () => {
    const f = projectFacts({ id: "p", distributorId: "d1", projectTypeId: "t1", participareISC: true, distributor: { code: "DISTRIGAZ" }, projectType: { code: "bransament" } });
    expect(f).toMatchObject({ distributorId: "d1", distributorCode: "DISTRIGAZ", projectTypeCode: "bransament", participareISC: true });
    expect(f).not.toHaveProperty("distributor");
    expect(projectFacts({ id: "p", distributor: null, projectType: null })).toMatchObject({ distributorCode: null, projectTypeCode: null });
  });
});
