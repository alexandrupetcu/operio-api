import { describe, expect, it } from "vitest";
import { companyDocVars, withoutBlankTenantFields } from "./company-doc-vars.js";

describe("companyDocVars — datele firmei din Setări → variabilele documentelor", () => {
  it("autorizația ANRE apare și sub numele folosite de dosarele DOCX (tenant_autorizatie_*)", () => {
    const v = companyDocVars({ company: { anreNr: "19833", anreTip: "EDIB", anreData: "09.12.2020", anreExp: "08.12.2025", postalCode: "077040" } });
    expect(v.tenant_anre_nr).toBe("19833");
    expect(v.tenant_autorizatie_anre).toBe("19833");
    expect(v.tenant_autorizatie_data).toBe("09.12.2020");
    expect(v.tenant_postal).toBe("077040");
  });

  it("fără setări → toate cheile există, goale (nu „undefined” în document)", () => {
    const v = companyDocVars(null);
    expect(Object.values(v).every((x) => x === "")).toBe(true);
    expect(v).toHaveProperty("tenant_postal");
  });

  it("autorizația de proiectare a firmei (PDSB) pentru dosarele de branșament", () => {
    const v = companyDocVars({ company: { proiectareNr: "19830", proiectareData: "08.12.2025", proiectareTip: "PDSB" } });
    expect(v.tenant_autorizatie_proiectare_nr).toBe("19830");
    expect(v.tenant_autorizatie_proiectare_data).toBe("08.12.2025");
    expect(v.tenant_autorizatie_proiectare_tip).toBe("PDSB");
  });
});

describe("datele firmei necompletate în dosarele DOCX", () => {
  it("un câmp al firmei gol nu se tipărește gol (lasă „, , județul ,”) — rămâne nedefinit, ca generatorul să pună „..........”", () => {
    const data: Record<string, unknown> = { tenant_name: "Operio", tenant_address: "", tenant_phone: "  ", tenant_city: "Măgurele", client_name: "", tenant_logo: { s3Key: "x" } };
    expect(withoutBlankTenantFields(data)).toEqual({ tenant_name: "Operio", tenant_city: "Măgurele", client_name: "", tenant_logo: { s3Key: "x" } });
  });
});
