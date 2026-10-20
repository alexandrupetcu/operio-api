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

  it("fără certificare potrivită → nimic (rămân valorile vechi din credentials)", () => {
    expect(legacyCredentialsFromCerts("rte", [cert("anre_egiu", { number: "1" })])).toEqual({});
    expect(legacyCredentialsFromCerts(null, [cert("rte", { number: "1" })])).toEqual({});
  });
});
