import { describe, expect, it } from "vitest";
import {
  CERT_TYPES,
  certDisplayName,
  certForRole,
  legacyCredentialsFromCerts,
  stampOf,
  authorityOf,
  type CertLike,
} from "./certifications.js";

const cert = (type: string, over: Partial<CertLike> = {}): CertLike => ({
  type,
  number: null,
  domain: null,
  issuedAt: null,
  expiresAt: null,
  ...over,
});

describe("catalog", () => {
  it("codurile sunt unice și ANRE are cele 8 tipuri pentru persoane fizice", () => {
    expect(new Set(CERT_TYPES.map((t) => t.code)).size).toBe(CERT_TYPES.length);
    expect(CERT_TYPES.filter((t) => t.group === "ANRE").map((t) => t.short).sort()).toEqual(
      ["EGD", "EGIU", "EGL", "EGT", "PGD", "PGIU", "PGL", "PGT"],
    );
  });

  it("„Altă certificare” se afișează cu numele dat de utilizator", () => {
    expect(certDisplayName({ type: "other", label: "Electrician ANRE gr. IIA" })).toBe("Electrician ANRE gr. IIA");
    expect(certDisplayName({ type: "iscir_rvt" })).toMatch(/^RVT/);
  });
});

describe("certForRole", () => {
  it("instalatorul: execuție ANRE, EGIU înaintea EGD; proiectarea (PGIU) nu contează", () => {
    const certs = [cert("anre_pgiu"), cert("anre_egd"), cert("anre_egiu")];
    expect(certForRole("instalator", certs)?.type).toBe("anre_egiu");
    expect(certForRole("instalator", [cert("anre_pgiu")])).toBeUndefined();
  });

  it("două certificări de același tip: cea valabilă, nu cea expirată, oricare ar fi ordinea", () => {
    const now = new Date("2026-10-20T10:00:00Z");
    const old = cert("iscir_rsl", { number: "VECHI", expiresAt: new Date("2025-03-12") });
    const renewed = cert("iscir_rsl", { number: "NOU", expiresAt: new Date("2030-03-12") });
    expect(certForRole("rsl", [old, renewed], now)?.number).toBe("NOU");
    expect(certForRole("rsl", [renewed, old], now)?.number).toBe("NOU");
  });

  it("dintre cele valabile, cea care expiră cel mai târziu; una fără dată după cele datate; doar expirate → cea mai recentă", () => {
    const now = new Date("2026-10-20T10:00:00Z");
    const a = cert("iscir_rvt", { number: "A", expiresAt: new Date("2027-01-01") });
    const b = cert("iscir_rvt", { number: "B", expiresAt: new Date("2029-01-01") });
    const undated = cert("iscir_rvt", { number: "FARA" });
    expect(certForRole("rvt", [a, undated, b], now)?.number).toBe("B");
    expect(certForRole("rvt", [undated, cert("iscir_rvt", { number: "EXP", expiresAt: new Date("2020-01-01") })], now)?.number).toBe("FARA");
    const e1 = cert("iscir_rvt", { number: "E1", expiresAt: new Date("2020-01-01") });
    const e2 = cert("iscir_rvt", { number: "E2", expiresAt: new Date("2024-01-01") });
    expect(certForRole("rvt", [e1, e2], now)?.number).toBe("E2");
  });

  it("ordinea tipurilor rămâne prima regulă: EGIU (chiar expirat) înaintea EGD", () => {
    const now = new Date("2026-10-20T10:00:00Z");
    const egiu = cert("anre_egiu", { expiresAt: new Date("2026-08-09") });
    const egd = cert("anre_egd", { expiresAt: new Date("2031-01-01") });
    expect(certForRole("instalator", [egd, egiu], now)?.type).toBe("anre_egiu");
  });

  it("RVT și RSL-IP sunt roluri separate, chiar dacă același om le are pe amândouă", () => {
    const certs = [cert("iscir_rsl"), cert("iscir_rvt")];
    expect(certForRole("rvt", certs)?.type).toBe("iscir_rvt");
    expect(certForRole("rsl", certs)?.type).toBe("iscir_rsl");
  });
});

describe("stampOf", () => {
  it("ștampila pe care e trecută certificarea; fără ștampilă sau fără imagine → null", () => {
    expect(stampOf(cert("anre_egiu", { stamp: { s3Key: "t/anre.png" } }))).toBe("t/anre.png")
    expect(stampOf(cert("iscir_rvt", { stamp: { s3Key: null } }))).toBeNull()
    expect(stampOf(cert("iscir_rvt"))).toBeNull()
  });
});

describe("authorityOf", () => {
  it("autoritatea vine din grupul catalogului", () => {
    expect(authorityOf("anre_pgd")).toBe("ANRE");
    expect(authorityOf("iscir_rsl")).toBe("ISCIR");
    expect(authorityOf("rte")).toBe("Construcții");
    expect(authorityOf("other")).toBe("Altele");
  });
});

describe("legacyCredentialsFromCerts — variabilele dosarelor de proiect", () => {
  it("instalator: legitimație, tip, valabilitate (dd.mm.yyyy), anul", () => {
    const out = legacyCredentialsFromCerts("instalator", [
      cert("anre_egiu", { number: "408160011", issuedAt: new Date("2016-08-09"), expiresAt: new Date("2026-08-09") }),
    ]);
    expect(out).toEqual({ legitimatie: "408160011", tip: "EGIU", valabilitate: "09.08.2026", anul: "2016" });
  });

  it("RTE: atestat + domeniu; sudor: autorizațiile ISCIR / PE + poanson", () => {
    expect(legacyCredentialsFromCerts("rte", [cert("rte", { number: "A-1", domain: "Instalații gaze" })])).toEqual({
      atestat: "A-1",
      domeniu: "Instalații gaze",
    });
    expect(
      legacyCredentialsFromCerts("sudor", [cert("iscir_sudor", { number: "OL-7", domain: "P12" }), cert("sudor_pe", { number: "PE-3" })]),
    ).toEqual({ autorizatie_ol_iscir: "OL-7", autorizatie_pe_iscir: "PE-3", poanson: "P12" });
  });

  it("atestat RTE reînnoit: dosarul primește cel valabil, nu cel expirat pus primul", () => {
    const out = legacyCredentialsFromCerts("rte", [
      cert("rte", { number: "VECHI", expiresAt: new Date("2020-01-01") }),
      cert("rte", { number: "NOU", expiresAt: new Date("2099-01-01") }),
    ]);
    expect(out.atestat).toBe("NOU");
  });

  it("fără certificare potrivită → nimic (rămân valorile vechi din credentials)", () => {
    expect(legacyCredentialsFromCerts("rte", [cert("anre_egiu", { number: "1" })])).toEqual({});
    expect(legacyCredentialsFromCerts(null, [cert("rte", { number: "1" })])).toEqual({});
  });
});
