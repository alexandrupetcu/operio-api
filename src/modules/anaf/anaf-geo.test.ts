import { describe, expect, it } from "vitest";
import { isValidCui, normalizePlace, streetAddress, titleCaseRo } from "./anaf-geo.js";

describe("isValidCui", () => {
  it("acceptă CUI-uri valide, cu sau fără prefixul RO", () => {
    expect(isValidCui("45606440")).toBe(true);
    expect(isValidCui("RO45606440")).toBe(true);
    expect(isValidCui("ro 45606440")).toBe(true);
    expect(isValidCui("RO 13548146")).toBe(true);
  });

  it("respinge cifra de control greșită", () => {
    expect(isValidCui("45606441")).toBe(false);
    expect(isValidCui("45606442")).toBe(false);
    expect(isValidCui("13548147")).toBe(false);
  });

  it("respinge lungimile imposibile", () => {
    expect(isValidCui("")).toBe(false);
    expect(isValidCui("4")).toBe(false);
    expect(isValidCui("RO")).toBe(false);
    expect(isValidCui("12345678901")).toBe(false); // 11 cifre
  });

  it("respinge un text fără cifre", () => {
    expect(isValidCui("abcdefg")).toBe(false);
  });

  it("ATENȚIE: un CUI trunchiat poate rămâne valid după cifra de control", () => {
    // „45606" (primele 5 cifre din 45606440) trece verificarea: 7·4+5·5+3·6+2·0 = 71,
    // 710 mod 11 = 6 = ultima cifră. Algoritmul se aplică pe orice lungime 2–10,
    // deci el NU poate respinge o trunchiere — de asta comentariul din modul spune
    // „un număr trunchiat poate fi al altcuiva". Testul fixează comportamentul
    // actual, ca o eventuală strângere a regulii (ex. minim 6 cifre) să fie o
    // decizie explicită, nu un efect secundar.
    expect(isValidCui("45606")).toBe(true);
    expect(isValidCui("4560644")).toBe(false); // trunchierea la 7 cifre, în schimb, nu trece
  });
});

describe("normalizePlace", () => {
  it("scoate prefixele ANAF și diacriticele", () => {
    expect(normalizePlace("MUNICIPIUL BUCUREŞTI")).toBe("bucuresti");
    expect(normalizePlace("Orş. Voluntari")).toBe("voluntari");
    expect(normalizePlace("Mun. Ploieşti")).toBe("ploiesti");
    expect(normalizePlace("Com. Berceni")).toBe("berceni");
    expect(normalizePlace("Sat Tunari")).toBe("tunari");
    expect(normalizePlace("Oras Otopeni")).toBe("otopeni");
    expect(normalizePlace("Comuna Chiajna")).toBe("chiajna");
  });

  it("sectoarele se reduc la „sector N”, oriunde apar în șir", () => {
    expect(normalizePlace("Sector 5 Mun. Bucureşti")).toBe("sector 5");
    expect(normalizePlace("SECTORUL 1")).toBe("sector 1");
    expect(normalizePlace("Bucuresti Sector 3")).toBe("sector 3");
    expect(normalizePlace("sector3")).toBe("sector 3"); // spațiul e opțional
  });

  it("taie calificativele de la final („jud. …”, „mun.”)", () => {
    expect(normalizePlace("Voluntari jud. Ilfov")).toBe("voluntari");
    expect(normalizePlace("Ploiesti mun.")).toBe("ploiesti");
    expect(normalizePlace("Snagov judetul Ilfov")).toBe("snagov");
  });

  it("normalizează ț/ș cu virguliță și cu sedilă la fel", () => {
    expect(normalizePlace("Constanţa")).toBe(normalizePlace("Constanța"));
    expect(normalizePlace("Timişoara")).toBe("timisoara");
    expect(normalizePlace("Bucureşti")).toBe(normalizePlace("București"));
  });

  it("colapsează spațiile și liniuțele", () => {
    expect(normalizePlace("  Târgu-Mureş  ")).toBe("targu mures");
    expect(normalizePlace("Satu_Mare")).toBe("satu mare");
  });

  it("text gol → șir gol", () => {
    expect(normalizePlace("")).toBe("");
    expect(normalizePlace("   ")).toBe("");
  });
});

describe("titleCaseRo", () => {
  it("majuscule ANAF → Title Case cu diacritice corecte", () => {
    expect(titleCaseRo("ŞOS. BUCUREŞTI NORD")).toBe("Șos. București Nord");
    expect(titleCaseRo("STR. MOŢOC")).toBe("Str. Moțoc");
  });

  it("abrevierile de unitate rămân cu literă mică LA MIJLOCUL unui segment", () => {
    expect(titleCaseRo("STR. MOŢOC NR.2 BL.P3 SC.3 AP.56")).toBe("Str. Moțoc nr. 2 bl. P3 sc. 3 ap. 56");
    expect(titleCaseRo("STR. LUNGA NR. 7 BL. P3 AP. 2")).toBe("Str. Lunga nr. 7 bl. P3 ap. 2");
  });

  it("la ÎNCEPUTUL unui segment, abrevierea capătă majusculă (ultimul pas câștigă)", () => {
    // Regula „fiecare segment separat de virgulă începe cu majusculă" se aplică
    // după coborârea abrevierilor, deci „, BL.P3" iese „, Bl. P3", nu „, bl. P3".
    expect(titleCaseRo("STR. MOŢOC NR.2, PARTER, BL.P3, SC.3, AP.56")).toBe(
      "Str. Moțoc nr. 2, Parter, Bl. P3, Sc. 3, Ap. 56",
    );
  });

  it("codurile literă+cifră rămân cu majusculă", () => {
    expect(titleCaseRo("BL. p3")).toBe("Bl. P3");
    expect(titleCaseRo("bl. o11, sc. a")).toBe("Bl. O11, Sc. A");
  });

  it("fiecare segment separat de virgulă începe cu majusculă", () => {
    expect(titleCaseRo("parter, etaj 1, camera 3")).toBe("Parter, Etaj 1, Camera 3");
  });

  it("colapsează spațiile multiple", () => {
    expect(titleCaseRo("STR.   LUNGA    NR.   7")).toBe("Str. Lunga nr. 7");
  });
});

describe("streetAddress", () => {
  it("aruncă segmentele de județ / localitate / sector și păstrează bl./sc./ap.", () => {
    expect(streetAddress("JUD. ILFOV, ORŞ. VOLUNTARI, STR. MOŢOC NR.2, BL.P3, SC.3, AP.56")).toBe(
      "Str. Moțoc nr. 2, Bl. P3, Sc. 3, Ap. 56",
    );
  });

  it("scoate și sectorul din față", () => {
    expect(streetAddress("MUN. BUCUREŞTI, SECTOR 5, STR. LUNGA NR. 7, AP. 2")).toBe("Str. Lunga nr. 7, Ap. 2");
  });

  it("păstrează parterul și etajul", () => {
    expect(streetAddress("JUD. ILFOV, COM. BERCENI, STR. SCURTA NR.1, PARTER")).toBe("Str. Scurta nr. 1, Parter");
  });

  it("o adresă fără prefixe de loc rămâne neatinsă (doar title-case)", () => {
    expect(streetAddress("STR. AVIATORILOR NR. 10")).toBe("Str. Aviatorilor nr. 10");
  });

  it("nu golește adresa când TOTUL arată a localitate (păstrează ultimul segment)", () => {
    expect(streetAddress("JUD. ILFOV, ORŞ. VOLUNTARI")).toBe("Orș. Voluntari");
  });

  it("segmentele goale se ignoră", () => {
    expect(streetAddress("JUD. ILFOV, , STR. LUNGA NR. 7, ")).toBe("Str. Lunga nr. 7");
  });
});
