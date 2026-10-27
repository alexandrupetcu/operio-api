/**
 * Catalogul certificărilor profesionale ale angajaților și colaboratorilor
 * (`EmployeeCertification.type`) și regulile care le leagă de documente.
 *
 * Surse: ANRE — Regulamentul pentru autorizarea persoanelor fizice din sectorul
 * gazelor naturale (Ord. ANRE 65/2023): P = proiectare, E = execuție; GIU =
 * instalații de utilizare, GD = distribuție, GT = transport, GL = GNL; valabile
 * 5 ani. ISCIR — PT A1-2010: RSL (supravegherea lucrărilor), RVT (verificări
 * tehnice), RSVTI (la deținător). Construcții: RTE, diriginte, verificator, CQ.
 */

export type CertGroup = "ANRE" | "ISCIR" | "Construcții" | "Altele";

export interface CertType {
  code: string;
  /** Codul scurt de pe ștampilă / fișă (ex. „EGIU”, „RVT”). */
  short: string;
  label: string;
  group: CertGroup;
  numberLabel: string;
  /** Al doilea câmp, când tipul îl are (domeniu, poanson…); `null` = nu se afișează. */
  domainLabel: string | null;
  /** Valabilitatea legală, pentru a propune data expirării. */
  validityYears?: number;
}

const anre = (short: string, what: string, validityYears = 5): CertType => ({
  code: `anre_${short.toLowerCase()}`,
  short,
  label: `${short} — ${what}`,
  group: "ANRE",
  numberLabel: "Nr. legitimație",
  domainLabel: null,
  validityYears,
});

export const CERT_TYPES: CertType[] = [
  anre("EGIU", "execuție instalații de utilizare gaze naturale"),
  anre("EGD", "execuție sisteme de distribuție gaze naturale"),
  anre("EGT", "execuție sisteme de transport gaze naturale"),
  anre("EGL", "execuție instalații GNL"),
  anre("PGIU", "proiectare instalații de utilizare gaze naturale"),
  anre("PGD", "proiectare sisteme de distribuție gaze naturale"),
  anre("PGT", "proiectare sisteme de transport gaze naturale"),
  anre("PGL", "proiectare instalații GNL"),
  { code: "iscir_rvt", short: "RVT", label: "RVT — responsabil cu verificări tehnice (ISCIR)", group: "ISCIR", numberLabel: "Nr. atestat", domainLabel: "Domeniu / aparate" },
  { code: "iscir_rsl", short: "RSL-IP", label: "RSL-IP — responsabil supravegherea lucrărilor (ISCIR)", group: "ISCIR", numberLabel: "Nr. atestat", domainLabel: "Domeniu / aparate" },
  { code: "iscir_rsvti", short: "RSVTI", label: "RSVTI — supravegherea și verificarea tehnică a instalațiilor", group: "ISCIR", numberLabel: "Nr. autorizație", domainLabel: null },
  { code: "iscir_fochist", short: "Fochist", label: "Fochist (ISCIR)", group: "ISCIR", numberLabel: "Nr. autorizație", domainLabel: "Clasa" },
  { code: "iscir_sudor", short: "Sudor ISCIR", label: "Sudor autorizat ISCIR (oțel)", group: "ISCIR", numberLabel: "Nr. autorizație", domainLabel: "Poanson" },
  { code: "iscir_rts", short: "RTS", label: "RTS — responsabil tehnic cu sudura (ISCIR)", group: "ISCIR", numberLabel: "Nr. atestat", domainLabel: null },
  { code: "rte", short: "RTE", label: "RTE — responsabil tehnic cu execuția", group: "Construcții", numberLabel: "Nr. atestat", domainLabel: "Domeniu" },
  { code: "diriginte", short: "Diriginte", label: "Diriginte de șantier", group: "Construcții", numberLabel: "Nr. legitimație", domainLabel: "Domeniu" },
  { code: "verificator", short: "Verificator", label: "Verificator de proiecte", group: "Construcții", numberLabel: "Nr. legitimație", domainLabel: "Domeniu" },
  { code: "cq", short: "CQ", label: "Responsabil cu controlul calității (CQ)", group: "Construcții", numberLabel: "Nr. certificat", domainLabel: null },
  { code: "sudor_pe", short: "Sudor PE", label: "Sudor polietilenă (PE)", group: "Altele", numberLabel: "Nr. autorizație", domainLabel: "Poanson" },
  { code: "other", short: "", label: "Altă certificare", group: "Altele", numberLabel: "Număr", domainLabel: "Detalii" },
];

export const CERT_TYPE_CODES = CERT_TYPES.map((t) => t.code) as [string, ...string[]];
const byCode = new Map(CERT_TYPES.map((t) => [t.code, t]));
export const certType = (code: string): CertType | undefined => byCode.get(code);

/** Ce câmpuri ale unei certificări folosesc regulile de mai jos. */
export interface CertLike {
  type: string;
  label?: string | null;
  number: string | null;
  domain: string | null;
  issuedAt: Date | null;
  expiresAt: Date | null;
  /** Ștampila pe care e trecută certificarea (cel mult una). */
  stamp?: { s3Key: string | null } | null;
}

/** Numele afișat: eticheta catalogului sau, pentru „other”, numele dat de utilizator. */
export function certDisplayName(c: Pick<CertLike, "type" | "label">): string {
  if (c.type === "other") return c.label?.trim() || "Altă certificare";
  return certType(c.type)?.label ?? c.type;
}

// ── Roluri de semnatar pe documente ──────────────────────────────────────────

/**
 * Cine semnează și ștampilează, pe ce documente, cu ce certificări (în ordinea
 * preferinței). Setarea firmei („semnatar implicit”) alege un angajat per rol.
 */
export const SIGNATORY_ROLES = [
  {
    key: "instalator",
    label: "Instalator autorizat",
    description: "Fișele de revizie / verificare a instalației de utilizare (RT, FISA) — rândul „Instalatorul autorizat” și semnătura lui.",
    certTypes: ["anre_egiu", "anre_egd", "anre_egt", "anre_egl"],
  },
  {
    key: "rvt",
    label: "RVT",
    description: "Raportul ISCIR de revizie a centralei — caseta „RVT (numele, semnătura și ștampila)”.",
    certTypes: ["iscir_rvt"],
  },
  {
    key: "rsl",
    label: "RSL-IP",
    description: "Raportul ISCIR de revizie a centralei — rândul „RSL IP”, la proba de presiune a circuitului de apă.",
    certTypes: ["iscir_rsl"],
  },
] as const;

export type SignatoryRole = (typeof SIGNATORY_ROLES)[number]["key"];
export const SIGNATORY_ROLE_KEYS = SIGNATORY_ROLES.map((r) => r.key) as [SignatoryRole, ...SignatoryRole[]];

export function certTypesForRole(role: SignatoryRole): readonly string[] {
  return SIGNATORY_ROLES.find((r) => r.key === role)!.certTypes;
}

/**
 * Certificarea cu care semnează persoana pentru `role`. Întâi tipul, în ordinea
 * preferinței din catalog (instalator: EGIU › EGD › …). Între mai multe de același
 * tip (ex. atestatul vechi și cel reînnoit): o valabilă, cea care expiră cel mai
 * târziu; apoi una fără dată de expirare; abia la urmă una expirată (cea mai recentă).
 */
export function certForRole<T extends Pick<CertLike, "type"> & { expiresAt?: Date | null }>(
  role: SignatoryRole,
  certs: T[],
  now = new Date(),
): T | undefined {
  return bestOfTypes(certTypesForRole(role), certs, now);
}

/** Prima dintre `types` (în ordine) pe care persoana o are, aleasă ca în `certForRole`. */
export function bestOfTypes<T extends Pick<CertLike, "type"> & { expiresAt?: Date | null }>(
  types: readonly string[],
  certs: T[],
  now = new Date(),
): T | undefined {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  // Rang: 0 = valabilă (datată), 1 = fără dată, 2 = expirată; în rang, expirarea cea mai târzie.
  const rank = (c: T) => (!c.expiresAt ? 1 : c.expiresAt.getTime() >= today ? 0 : 2);
  for (const type of types) {
    const same = certs.filter((c) => c.type === type);
    if (same.length === 0) continue;
    return [...same].sort((a, b) => rank(a) - rank(b) || (b.expiresAt?.getTime() ?? 0) - (a.expiresAt?.getTime() ?? 0))[0];
  }
  return undefined;
}

/** Autoritatea unei certificări = grupul din catalog („ANRE”, „ISCIR”…); ștampila o are la fel. */
export const STAMP_AUTHORITIES: CertGroup[] = ["ANRE", "ISCIR", "Construcții", "Altele"];
export function authorityOf(type: string): CertGroup {
  return certType(type)?.group ?? "Altele";
}

/**
 * Ștampila de pus pentru o certificare: imaginea ștampilei pe care e trecută —
 * explicit, fără împrumut de la alte certificări (o ștampilă ISCIR doar cu RSL-IP
 * nu ajunge în caseta RVT). `null` dacă nu e pe nicio ștampilă sau ștampila n-are imagine.
 */
export function stampOf(cert: Pick<CertLike, "stamp">): string | null {
  return cert.stamp?.s3Key ?? null;
}

// ── Compatibilitate cu variabilele dosarelor de proiect ({rol}_legitimatie…) ──

const fmtDate = (d: Date | null) => (d ? d.toLocaleDateString("ro-RO", { timeZone: "UTC" }) : "");

/**
 * Cheile vechi din `Employee.credentials` pe care le citesc dosarele de proiect
 * ({instalator_legitimatie}, {rte_atestat}, {sudor_ol_aut_iscir}…), calculate din
 * certificări. Se aplică PESTE `credentials` (care rămâne rezervă pentru datele
 * vechi), doar pentru cheile care au valoare.
 */
export function legacyCredentialsFromCerts(position: string | null | undefined, certs: CertLike[]): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: string | null | undefined) => {
    if (v && v.trim()) out[k] = v.trim();
  };
  const pick = (types: string[]) => bestOfTypes(types, certs);
  const anreLike = (c: CertLike | undefined) => {
    if (!c) return;
    put("legitimatie", c.number);
    put("tip", certType(c.type)?.short);
    put("valabilitate", fmtDate(c.expiresAt));
    put("legitimatie_data", fmtDate(c.issuedAt));
    if (c.issuedAt) put("anul", String(c.issuedAt.getUTCFullYear()));
  };
  // Toate certificările valabile (sau fără dată) de același tip, în ordinea introducerii —
  // un sudor PE are de regulă câte o autorizație pe procedeu (SD, SRM, SRS).
  const allOf = (type: string) => {
    const today = Date.now();
    const same = certs.filter((c) => c.type === type && c.number?.trim());
    const valid = same.filter((c) => !c.expiresAt || c.expiresAt.getTime() >= today - 86_400_000);
    return (valid.length ? valid : same).map((c) => c.number!.trim());
  };

  switch (position) {
    case "instalator":
      anreLike(pick(["anre_egiu", "anre_egd", "anre_egt", "anre_egl"]));
      break;
    case "proiectant":
      anreLike(pick(["anre_pgiu", "anre_pgd", "anre_pgt", "anre_pgl"]));
      break;
    case "rte": {
      const c = pick(["rte"]);
      put("atestat", c?.number);
      put("domeniu", c?.domain);
      put("atestat_data", fmtDate(c?.issuedAt ?? null));
      // Șabloanele de branșament cer {rte_autorizatie}: e atestatul RTE.
      put("autorizatie", c?.number);
      break;
    }
    case "rts": {
      const c = pick(["iscir_rts"]);
      put("atestat", c?.number);
      put("atestat_data", fmtDate(c?.issuedAt ?? null));
      break;
    }
    case "diriginte":
    case "verificator": {
      const c = pick([position]);
      put("legitimatie", c?.number);
      put("domeniu", c?.domain);
      put("legitimatie_data", fmtDate(c?.issuedAt ?? null));
      if (position === "verificator") put("valabilitate", fmtDate(c?.expiresAt ?? null));
      break;
    }
    case "sudor": {
      const ol = pick(["iscir_sudor"]);
      const pe = pick(["sudor_pe"]);
      put("autorizatie_ol_iscir", ol?.number);
      put("autorizatie_pe_iscir", pe?.number);
      put("poanson", ol?.domain || pe?.domain);
      const peAll = allOf("sudor_pe");
      const olAll = allOf("iscir_sudor");
      if (peAll.length) put("autorizatii_pe", peAll.join(", "));
      if (olAll.length) put("autorizatii_ol", olAll.join(", "));
      put("autorizatie_pe_data", fmtDate(pe?.issuedAt ?? null));
      put("autorizatie_ol_data", fmtDate(ol?.issuedAt ?? null));
      break;
    }
  }
  return out;
}
