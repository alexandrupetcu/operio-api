import { describe, expect, it } from "vitest";
import { REPORT_FILE_CANONICAL_MIME, REPORT_FILE_MIMETYPES, reportFileKind } from "./pdf-text.js";

describe("reportFileKind — extensia bate mimetype-ul", () => {
  it("extensia decide, chiar când clientul minte în mimetype", () => {
    expect(reportFileKind("raport.pdf", "text/html")).toBe("pdf");
    expect(reportFileKind("date.csv", "application/pdf")).toBe("csv");
    expect(reportFileKind("date.xml", "text/plain")).toBe("xml");
    expect(reportFileKind("note.txt", "application/xml")).toBe("txt");
  });

  it("extensia e insensibilă la majuscule", () => {
    expect(reportFileKind("RAPORT.PDF")).toBe("pdf");
    expect(reportFileKind("Date.CsV")).toBe("csv");
  });

  it("fără extensie se cade pe mimetype", () => {
    expect(reportFileKind("raport", "application/pdf")).toBe("pdf");
    expect(reportFileKind("date", "text/csv")).toBe("csv");
    expect(reportFileKind("date", "text/comma-separated-values")).toBe("csv");
    expect(reportFileKind("date", "application/xml")).toBe("xml");
    expect(reportFileKind("date", "text/xml")).toBe("xml");
    expect(reportFileKind("date", "text/plain")).toBe("txt");
  });

  it("mimetype-ul cu parametri (`; charset=`) se normalizează", () => {
    expect(reportFileKind("date", "text/csv; charset=utf-8")).toBe("csv");
    expect(reportFileKind("date", "  TEXT/CSV ; charset=UTF-8")).toBe("csv");
  });

  it("`application/octet-stream` fără extensie utilă → null (rezerva e la apelant)", () => {
    expect(reportFileKind("raport", "application/octet-stream")).toBeNull();
    expect(reportFileKind(undefined, "application/octet-stream")).toBeNull();
  });

  it("`application/octet-stream` CU extensie cunoscută trece pe extensie", () => {
    expect(reportFileKind("date.csv", "application/octet-stream")).toBe("csv");
    expect(reportFileKind("raport.pdf", "application/octet-stream")).toBe("pdf");
  });

  it(".xls / .xlsx trimis ca `application/vnd.ms-excel` e REFUZAT (nu e CSV)", () => {
    expect(reportFileKind("date.xls", "application/vnd.ms-excel")).toBeNull();
    expect(reportFileKind("date.xlsx", "application/vnd.ms-excel")).toBeNull();
    expect(reportFileKind("date.xls")).toBeNull();
  });

  it("limita cunoscută: garda pe .xls e legată de `application/vnd.ms-excel`", () => {
    // Un .xls declarat `text/csv` trece ca CSV — nu e o breșă (se decodează ca
    // text și detecția nu găsește perechi), dar e bine să fie fixat în test.
    expect(reportFileKind("date.xls", "text/csv")).toBe("csv");
  });

  it("`application/vnd.ms-excel` cu .csv real sau fără extensie trece ca CSV", () => {
    expect(reportFileKind("date.csv", "application/vnd.ms-excel")).toBe("csv");
    expect(reportFileKind("date", "application/vnd.ms-excel")).toBe("csv");
  });

  it("tipuri neacceptate → null", () => {
    expect(reportFileKind("x.docx")).toBeNull();
    expect(reportFileKind("x.zip", "application/zip")).toBeNull();
    expect(reportFileKind("x.html", "text/html")).toBeNull();
    expect(reportFileKind(null, null)).toBeNull();
    expect(reportFileKind("", "")).toBeNull();
  });

  it("traversarea de cale nu schimbă deducția (extname pe tot numele)", () => {
    expect(reportFileKind("../../etc/passwd.pdf")).toBe("pdf");
  });
});

describe("constantele de mimetype", () => {
  it("lista acceptată le conține pe toate cele folosite în validări", () => {
    expect(REPORT_FILE_MIMETYPES).toContain("application/pdf");
    expect(REPORT_FILE_MIMETYPES).toContain("text/csv");
    expect(REPORT_FILE_MIMETYPES).toContain("application/xml");
    expect(REPORT_FILE_MIMETYPES).toContain("text/plain");
  });

  it("fiecare fel de fișier are un mimetype canonic", () => {
    expect(REPORT_FILE_CANONICAL_MIME).toEqual({
      pdf: "application/pdf",
      xml: "application/xml",
      csv: "text/csv",
      txt: "text/plain",
    });
  });
});
