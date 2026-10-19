import { describe, expect, it } from "vitest";
import {
  CERT_TYPES,
  certDisplayName,
  certForRole,
  legacyCredentialsFromCerts,
  stampFor,
  type CertLike,
} from "./certifications.js";

const cert = (type: string, over: Partial<CertLike> = {}): CertLike => ({
  type,
  number: null,
  domain: null,
  issuedAt: null,
  expiresAt: null,
  stampS3Key: null,
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

describe("stampFor", () => {
  it("ștampila de instalator, încărcată pe PGD, acoperă și EGIU-ul aceluiași om", () => {
    const certs = [cert("anre_egiu"), cert("anre_pgd", { stampS3Key: "t/stamp-anre.png" })];
    expect(stampFor(certs[0], certs)).toBe("t/stamp-anre.png");
  });

  it("nu împrumută ștampila altei autorități (ANRE ≠ ISCIR)", () => {
    const certs = [cert("iscir_rvt"), cert("anre_egiu", { stampS3Key: "t/anre.png" })];
    expect(stampFor(certs[0], certs)).toBeNull();
  });

  it("ștampila proprie a certificării are prioritate", () => {
    const certs = [cert("iscir_rvt", { stampS3Key: "t/rvt.png" }), cert("iscir_rsl", { stampS3Key: "t/rsl.png" })];
    expect(stampFor(certs[1], certs)).toBe("t/rsl.png");
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
