/** Serviciul ANAF nu răspunde (mentenanță, HTML în loc de JSON, eroare HTTP). */
export class AnafUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "AnafUnavailableError"; }
}

const ANAF_URL = "https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva";

export interface AnafCompanyData {
  cui: string;
  denumire: string;
  adresa: string;
  nrRegCom: string;
  telefon: string;
  codPostal: string;
  stare_inregistrare: string;
  data_inregistrare: string;
  cod_CAEN: string;
  scpTVA: boolean;
  statusInactivi: boolean;
  sediu: {
    strada: string;
    numar: string;
    detalii: string;
    localitate: string;
    judet: string;
    codJudet: string;
    codPostal: string;
  };
}

export async function lookupCui(cui: string): Promise<AnafCompanyData | null> {
  const cuiNum = parseInt(cui.replace(/\D/g, ""), 10);
  if (!cuiNum || isNaN(cuiNum)) return null;

  const today = new Date().toISOString().split("T")[0];

  const res = await fetch(ANAF_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ cui: cuiNum, data: today }]),
  });

  if (!res.ok) throw new AnafUnavailableError(`ANAF HTTP ${res.status}`);

  // ANAF răspunde uneori cu o pagină HTML de mentenanță (200 OK) — nu e „CUI inexistent”.
  const text = await res.text();
  let data: { found?: any[] };
  try {
    data = JSON.parse(text);
  } catch {
    throw new AnafUnavailableError("ANAF a răspuns cu conținut non-JSON");
  }
  if (!data.found || data.found.length === 0) return null;

  const record = data.found[0];
  const gen = record.date_generale ?? {};
  const tva = record.inregistrare_scop_Tva ?? {};
  const inactiv = record.stare_inactiv ?? {};
  const sediu = record.adresa_sediu_social ?? {};

  return {
    cui: String(gen.cui ?? cui),
    denumire: gen.denumire ?? "",
    adresa: gen.adresa ?? "",
    nrRegCom: gen.nrRegCom ?? "",
    telefon: gen.telefon ?? "",
    codPostal: gen.codPostal ?? "",
    stare_inregistrare: gen.stare_inregistrare ?? "",
    data_inregistrare: gen.data_inregistrare ?? "",
    cod_CAEN: gen.cod_CAEN ?? "",
    scpTVA: tva.scpTVA === true,
    statusInactivi: inactiv.statusInactivi === true,
    sediu: {
      strada: sediu.sdenumire_Strada ?? "",
      numar: sediu.snumar_Strada ?? "",
      detalii: sediu.sdetalii_Adresa ?? "",
      localitate: sediu.sdenumire_Localitate ?? "",
      judet: sediu.sdenumire_Judet ?? "",
      codJudet: sediu.scod_Judet ?? "",
      codPostal: sediu.scod_Postal ?? "",
    },
  };
}
