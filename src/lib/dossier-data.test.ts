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

  it("directorul OSD (PVRTL NEOGAS: „Aprob admiterea”)", () => {
    expect(distributorDocVars({ name: "Neogas Grid S.A.", contactJson: { director: "IONITA Ion – Director Executiv" } }, {}).osd_director).toBe("IONITA Ion – Director Executiv");
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
    expect(derivedDossierVars({})).toMatchObject({ suduri: [], total_suduri: "" });
  });
});

describe("derivedDossierVars — dosarul NEOGAS (contract 28.10, partea a doua)", () => {
  it("strada salvată din pagina Dosare (lucrare_strada) ajunge în {project_street}", () => {
    expect(derivedDossierVars({ project_street: "", lucrare_strada: "Sabarului" }).project_street).toBe("Sabarului");
    expect(derivedDossierVars({ project_street: "Unirii", lucrare_strada: "Sabarului" }).project_street).toBeUndefined();
  });

  it("câmpurile-tabel: un rând pe linie, celulele despărțite prin „|”, cu nr_crt", () => {
    const v = derivedDossierVars({ materiale: "Țeavă PE | 32 | 4 | TEHNO WORLD S.R.L. | 25387663 / 04.08.2025 | 25097383 / 04.08.2025\nNisip |  |  | PREDI TRANS S.R.L. |  | 20288-CPR" });
    expect(v.materiale).toEqual([
      { nr_crt: "1", denumire: "Țeavă PE", diametru: "32", cantitate: "4", furnizor: "TEHNO WORLD S.R.L.", certificat: "25387663 / 04.08.2025", declaratie: "25097383 / 04.08.2025" },
      { nr_crt: "2", denumire: "Nisip", diametru: "", cantitate: "", furnizor: "PREDI TRANS S.R.L.", certificat: "", declaratie: "20288-CPR" },
    ]);
  });

  it("tabel necompletat → rândurile implicite, cu celulele goale (se scriu de mână)", () => {
    const rows = derivedDossierVars({}).materiale as Record<string, string>[];
    expect(rows.length).toBeGreaterThan(5);
    expect(rows[0]).toMatchObject({ nr_crt: "1", denumire: "Capăt branșament PE-OL", furnizor: "" });
  });

  it("tabelul sudurilor completat → bucla suduri[] cu sudor, autorizație, procedeu, omologare", () => {
    const v = derivedDossierVars({ suduri_tabel: "S1 | Ivan Florin | 567380 | 111/BW | 89C-1150\nS3-46 | Mihaescu Florin | 568856 | SRM/SW | 052-946 / 04.09.2024", suduri_lista: "S79" });
    expect(v.suduri).toEqual([
      { nr_crt: "1", cod: "S1", sudor: "Ivan Florin", autorizatie: "567380", procedeu: "111/BW", omologare: "89C-1150", rezultat: "ADMIS" },
      { nr_crt: "2", cod: "S3-46", sudor: "Mihaescu Florin", autorizatie: "568856", procedeu: "SRM/SW", omologare: "052-946 / 04.09.2024", rezultat: "ADMIS" },
    ]);
    expect(v.total_suduri).toBe("2");
  });

  it("lungimea în km pentru anexa PVRTL: 5.00 m → „0,005”", () => {
    expect(derivedDossierVars({ project_length: "4.00", bransament_lungime_reiser: "1.00" }).project_length_km).toBe("0,005");
    expect(derivedDossierVars({ bransament_lungime_totala: "12,5" }).project_length_km).toBe("0,013");
    expect(derivedDossierVars({}).project_length_km).toBeUndefined();
  });

  it("anul certificatelor țevii, din data lor", () => {
    const v = derivedDossierVars({ teava_cc_data: "04.08.2025", teava_dc_data: "2024-12-30" });
    expect(v.teava_cc_an).toBe("2025");
    expect(v.teava_dc_an).toBe("2024");
  });

  it("MegaConstruct: abrevierea regimului de presiune, DN-ul conductei stradale din teu, detaliile adresei", () => {
    const v = derivedDossierVars({ bransament_presiune: "Medie presiune", teu_dn: "250/32", adresa_detalii: "(Nr. vechi 432) – NC 20995" });
    expect(v.bransament_presiune_abr).toBe("MP");
    expect(v.conducta_stradala_dn).toBe("250");
    expect(v.adresa_detalii_text).toBe(", (Nr. vechi 432) – NC 20995");
    expect(derivedDossierVars({ bransament_presiune: "Redusă presiune", teu_dn: "63 - 32" })).toMatchObject({ bransament_presiune_abr: "RP", conducta_stradala_dn: "63" });
    // Fără detalii: nimic tipărit (nu „..........” lipit de număr).
    expect(derivedDossierVars({}).adresa_detalii_text).toBe("");
  });

  it("firma RTE: implicit firma care execută; completată pe dosar rămâne", () => {
    expect(derivedDossierVars({ tenant_name: "PIC TERMO INSTAL GAZ S.R.L." }).rte_firma).toBe("PIC TERMO INSTAL GAZ S.R.L.");
    expect(derivedDossierVars({ tenant_name: "PIC", rte_firma: "ACTIVITATI DE INGINERIE SI CONSULTANTA S.R.L." }).rte_firma).toBeUndefined();
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

  it("numele de familie și prenumele separat (PV de predare a amplasamentului)", () => {
    const v = teamDocVars([
      { role: "diriginte", name: "Ion Daniel Rauta", firstName: "Ion Daniel", lastName: "Rauta", creds: {} },
      member("rte", "Coman Gabriel"),
    ]);
    expect(v.diriginte_nume_familie).toBe("Rauta");
    expect(v.diriginte_prenume).toBe("Ion Daniel");
    // Fără angajat (nume scris de mână): ca pe documente — întâi numele de familie.
    expect(v.rte_nume_familie).toBe("Coman");
    expect(v.rte_prenume).toBe("Gabriel");
  });

  it("tabelul sudorilor autorizați: un rând pe autorizație (OL, apoi PE)", () => {
    const v = teamDocVars([
      member("sudor", "Ivan Florin", { autorizatii_ol: "567380" }),
      member("sudor", "Mihaescu Florin", { autorizatii_pe: "568855, 568856, 568857" }),
      member("sudor", "Pop Ion"),
    ]);
    expect(v.sudori_autorizatii).toEqual([
      { nr_crt: "1", nume: "Ivan Florin", autorizatie: "567380" },
      { nr_crt: "2", nume: "Mihaescu Florin", autorizatie: "568855" },
      { nr_crt: "3", nume: "Mihaescu Florin", autorizatie: "568856" },
      { nr_crt: "4", nume: "Mihaescu Florin", autorizatie: "568857" },
      { nr_crt: "5", nume: "Pop Ion", autorizatie: "" },
    ]);
  });

  it("semnătura angajatului ajunge ca imagine", () => {
    const v = teamDocVars([member("rts", "Badea Nicolae", {}, "sig/rts.png")]);
    expect(v.rts_signature).toEqual({ s3Key: "sig/rts.png", mimetype: "image/png" });
  });
});

describe("durata probelor ca text", () => {
  it("minutele din dosar devin „1 oră și 20 min” / „24 ore și 5 min” / „45 min” / „2 ore”", () => {
    const d = derivedDossierVars({ proba_rezistenta_timp: "80", proba_etanseitate_timp: 1445 });
    expect(d.proba_rezistenta_durata_text).toBe("1 oră și 20 min");
    expect(d.proba_etanseitate_durata_text).toBe("24 ore și 5 min");
    expect(derivedDossierVars({ proba_rezistenta_timp: "45" }).proba_rezistenta_durata_text).toBe("45 min");
    expect(derivedDossierVars({ proba_rezistenta_timp: "120" }).proba_rezistenta_durata_text).toBe("2 ore");
    expect(derivedDossierVars({}).proba_rezistenta_durata_text).toBeUndefined();
  });
});
