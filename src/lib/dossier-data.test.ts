import { describe, expect, it } from "vitest";
import { derivedDossierVars, distributorDocVars, teamDocVars, type TeamMemberLike } from "./dossier-data.js";

describe("distributorDocVars — agenția OSD din Setări → Distribuitori", () => {
  const distributor = {
    name: "Distrigaz Sud Rețele S.R.L.",
    contactJson: { address: "B-dul Mărășești nr. 4-6, sect. 4", region: "București", sector: "Sectorul 4", phone: "021.301.17.40", fax: "021.301.18.05" },
  };

  it("expune denumirea și datele agenției", () => {
    expect(distributorDocVars(distributor, {})).toEqual({
      osd_denumire: "Distrigaz Sud Rețele S.R.L.",
      osd_adresa: "B-dul Mărășești nr. 4-6, sect. 4",
      osd_regiune: "București",
      osd_sector: "Sectorul 4",
      osd_telefon: "021.301.17.40",
      osd_fax: "021.301.18.05",
    });
  });

  it("valoarea completată pe dosar are prioritate; o valoare goală pe dosar nu ascunde distribuitorul", () => {
    const v = distributorDocVars(distributor, { osd_telefon: "0244 000 000", osd_fax: "" });
    expect(v.osd_telefon).toBe("0244 000 000");
    expect(v.osd_fax).toBe("021.301.18.05");
  });

  it("fără distribuitor → nimic (nu suprascrie nimic)", () => {
    expect(distributorDocVars(null, {})).toEqual({});
  });

  it("contactJson incomplet sau stricat → doar ce există", () => {
    expect(distributorDocVars({ name: "Neogas Grid S.A.", contactJson: "x" }, {})).toEqual({ osd_denumire: "Neogas Grid S.A." });
  });
});

describe("derivedDossierVars — câmpuri calculate", () => {
  it("lungimea totală = lungime + reiser, când lipsește și ambele sunt numere (cu virgulă sau punct)", () => {
    expect(derivedDossierVars({ project_length: "2.00", bransament_lungime_reiser: "1,30" }).bransament_lungime_totala).toBe("3.30");
  });

  it("lungimea totală completată de om rămâne cum e", () => {
    expect(derivedDossierVars({ project_length: "2", bransament_lungime_reiser: "1.3", bransament_lungime_totala: "3.5" }).bransament_lungime_totala).toBeUndefined();
  });

  it("fără reiser numeric → nu se calculează", () => {
    expect(derivedDossierVars({ project_length: "2", bransament_lungime_reiser: "" }).bransament_lungime_totala).toBeUndefined();
  });

  it("lista sudurilor → bucla suduri[] și totalul", () => {
    const v = derivedDossierVars({ suduri_lista: "S79, S80;S81\nS82" });
    expect(v.suduri).toEqual([
      { nr_crt: "1", cod: "S79", rezultat: "ADMIS" },
      { nr_crt: "2", cod: "S80", rezultat: "ADMIS" },
      { nr_crt: "3", cod: "S81", rezultat: "ADMIS" },
      { nr_crt: "4", cod: "S82", rezultat: "ADMIS" },
    ]);
    expect(v.total_suduri).toBe("4");
  });

  it("fără listă de suduri → buclă goală, total gol", () => {
    expect(derivedDossierVars({})).toEqual({ suduri: [], total_suduri: "" });
  });
});

const member = (role: string, name: string, creds: Record<string, string> = {}, signatureS3Key?: string): TeamMemberLike => ({ role, name, creds, signatureS3Key });

describe("teamDocVars — echipa dosarului", () => {
  it("rolurile primesc numele și câmpurile din certificări, inclusiv datele de emitere", () => {
    const v = teamDocVars([
      member("diriginte", "Rauta Ion Daniel", { legitimatie: "00030523", legitimatie_data: "12.02.2019" }),
      member("rts", "Badea Nicolae", { atestat: "DISPR/I/11982", atestat_data: "24.02.2022" }),
      member("rte", "Coman Gabriel", { atestat: "00002635", autorizatie: "00002635" }),
    ]);
    expect(v.diriginte_nume).toBe("Rauta Ion Daniel");
    expect(v.diriginte_legitimatie_data).toBe("12.02.2019");
    expect(v.rts_nume).toBe("Badea Nicolae");
    expect(v.rts_atestat).toBe("DISPR/I/11982");
    expect(v.rts_atestat_data).toBe("24.02.2022");
    expect(v.rte_autorizatie).toBe("00002635");
  });

  it("sudorul PE și sudorul OL se aleg după certificare, nu după ordinea alocării", () => {
    const v = teamDocVars([
      member("sudor", "Mihaescu Florin", { autorizatie_pe_iscir: "568855", autorizatii_pe: "568855, 568856, 568857", poanson: "PIC 05" }),
      member("sudor", "Ivan Florin", { autorizatie_ol_iscir: "567380", poanson: "PIC 04" }),
    ]);
    expect(v.sudor_pe_nume).toBe("Mihaescu Florin");
    expect(v.sudor_pe_autorizatii).toBe("568855, 568856, 568857");
    expect(v.sudor_pe_poanson).toBe("PIC 05");
    expect(v.sudor_ol_nume).toBe("Ivan Florin");
    expect(v.sudor_ol_autorizatii).toBe("567380");
    expect(v.sudor_ol_poanson).toBe("PIC 04");
  });

  it("un singur sudor fără certificări → PE și OL sunt el (comportamentul vechi)", () => {
    const v = teamDocVars([member("sudor", "Pop Ion", { autorizatii: "A-1", poanson: "P1" })]);
    expect(v.sudor_pe_nume).toBe("Pop Ion");
    expect(v.sudor_ol_nume).toBe("Pop Ion");
    expect(v.sudor_pe_autorizatii).toBe("A-1");
  });

  it("tabelul de sudori: un rând per sudor, cu PE/OL completate doar unde are certificare", () => {
    const v = teamDocVars([
      member("sudor", "Mihaescu Florin", { autorizatie_pe_iscir: "568855", poanson: "PIC 05" }),
      member("sudor", "Ivan Florin", { autorizatie_ol_iscir: "567380", poanson: "PIC 04" }),
    ]);
    const rows = v.project_sudori as Record<string, string>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ nr_crt: "1", sudor_pe_nume: "Mihaescu Florin", sudor_pe_aut_iscir: "568855", sudor_ol_aut_iscir: "" });
    expect(rows[1]).toMatchObject({ nr_crt: "2", sudor_ol_nume: "Ivan Florin", sudor_ol_aut_iscir: "567380", sudor_pe_aut_iscir: "" });
  });

  it("semnătura angajatului ajunge ca imagine", () => {
    const v = teamDocVars([member("rts", "Badea Nicolae", {}, "sig/rts.png")]);
    expect(v.rts_signature).toEqual({ s3Key: "sig/rts.png", mimetype: "image/png" });
  });
});
