import { describe, expect, it } from "vitest";
import { normalizeMaterialDoc } from "./material-doc.js";

describe("citirea facturilor, certificatelor și avizelor — normalizarea răspunsului", () => {
  it("datele în „dd.mm.yyyy”, câmpurile goale cad, materialele cu Dn și cantitate", () => {
    const d = normalizeMaterialDoc({
      tip_document: "certificat_calitate",
      furnizor: "  TEHNOWORLD SRL ",
      certificat_calitate: { nr: "25399134", data: "2025-07-24" },
      declaratie_conformitate: { nr: "25105205", data: "24/07/2025" },
      lot: "",
      materiale: [{ denumire: "Teava PE100 SDR11", diametru: "63 mm", cantitate: "2", um: "ml" }, { denumire: "" }],
    });
    expect(d).toEqual({
      tip: "certificat_calitate",
      furnizor: "TEHNOWORLD SRL",
      certificat: { nr: "25399134", data: "24.07.2025" },
      declaratie: { nr: "25105205", data: "24.07.2025" },
      materiale: [{ denumire: "Teava PE100 SDR11", diametru: "63", cantitate: "2 ml" }],
    });
  });

  it("avizul: denumire, emitent, număr, dată", () => {
    expect(normalizeMaterialDoc({ tip_document: "aviz", aviz: { denumire: "Aviz Electrica", emitent: "Electrica Furnizare", nr: "123/AV", data: "3.1.2025" } })).toEqual({
      tip: "aviz",
      aviz: { denumire: "Aviz Electrica", emitent: "Electrica Furnizare", nr: "123/AV", data: "03.01.2025" },
      materiale: [],
    });
  });

  it("un răspuns ciudat nu strică nimic", () => {
    expect(normalizeMaterialDoc(null)).toEqual({ tip: "altul", materiale: [] });
    expect(normalizeMaterialDoc({ tip_document: "chitanta", materiale: "nu e listă" })).toEqual({ tip: "altul", materiale: [] });
  });
});
