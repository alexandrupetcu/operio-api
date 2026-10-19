import { describe, expect, it } from "vitest";
import { safeS3Filename, uploadContentType } from "./safe-filename.js";

describe("safeS3Filename", () => {
  it("păstrează doar extensia, cu un nume aleator de 16 hex", () => {
    expect(safeS3Filename("factura.pdf")).toMatch(/^[0-9a-f]{16}\.pdf$/);
    expect(safeS3Filename("Raport Final.DOCX")).toMatch(/^[0-9a-f]{16}\.docx$/);
  });

  it("nu lasă numele original să ajungă în cheie (scurgere de date în URL-uri presemnate)", () => {
    expect(safeS3Filename("Popescu Ion - contract.pdf")).not.toContain("Popescu");
  });

  it("neutralizează traversarea de cale", () => {
    for (const name of ["../../etc/passwd.pdf", "..\\..\\windows\\win.ini.pdf", "/etc/shadow.pdf"]) {
      const out = safeS3Filename(name);
      expect(out).not.toContain("..");
      expect(out).not.toContain("/");
      expect(out).not.toContain("\\");
      expect(out).toMatch(/^[0-9a-f]{16}(\.[a-z0-9]+)?$/);
    }
  });

  it("scoate null bytes și caracterele de control", () => {
    expect(safeS3Filename("a\u0000b.pdf")).toMatch(/^[0-9a-f]{16}\.pdf$/);
    expect(safeS3Filename("a\u0007\u001fb.pdf")).toMatch(/^[0-9a-f]{16}\.pdf$/);
  });

  it("extensie dublă: contează doar ultima", () => {
    expect(safeS3Filename("shell.php.pdf")).toMatch(/^[0-9a-f]{16}\.pdf$/);
    expect(safeS3Filename("x.pdf.php")).toMatch(/^[0-9a-f]{16}\.php$/);
  });

  it("fără extensie (sau extensie nealfanumerică) → doar partea aleatoare", () => {
    expect(safeS3Filename("README")).toMatch(/^[0-9a-f]{16}$/);
    expect(safeS3Filename("arhiva.")).toMatch(/^[0-9a-f]{16}$/);
    expect(safeS3Filename("fisier.--")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("extensia se trunchiază la 16 caractere", () => {
    const out = safeS3Filename(`x.${"a".repeat(40)}`);
    expect(out).toMatch(/^[0-9a-f]{16}\.a{16}$/);
  });

  it("null / undefined / gol → doar partea aleatoare", () => {
    expect(safeS3Filename(null)).toMatch(/^[0-9a-f]{16}$/);
    expect(safeS3Filename(undefined)).toMatch(/^[0-9a-f]{16}$/);
    expect(safeS3Filename("")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("două încărcări ale aceluiași nume nu se suprascriu", () => {
    const names = new Set(Array.from({ length: 200 }, () => safeS3Filename("invoice.pdf")));
    expect(names.size).toBe(200);
  });
});

describe("uploadContentType", () => {
  it("deduce din extensie, nu din antetul clientului", () => {
    expect(uploadContentType("x.pdf")).toBe("application/pdf");
    expect(uploadContentType("x.PDF")).toBe("application/pdf");
    expect(uploadContentType("x.png")).toBe("image/png");
    expect(uploadContentType("x.jpg")).toBe("image/jpeg");
    expect(uploadContentType("x.jpeg")).toBe("image/jpeg");
    expect(uploadContentType("x.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(uploadContentType("x.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  it("extensie necunoscută / periculoasă → octet-stream (nu se servește ca HTML)", () => {
    expect(uploadContentType("x.html")).toBe("application/octet-stream");
    expect(uploadContentType("x.svg")).toBe("application/octet-stream");
    expect(uploadContentType("x.php")).toBe("application/octet-stream");
    expect(uploadContentType("x")).toBe("application/octet-stream");
    expect(uploadContentType(null)).toBe("application/octet-stream");
  });

  it("nu returnează chei moștenite din Object.prototype", () => {
    expect(uploadContentType("x.constructor")).toBe("application/octet-stream");
    expect(uploadContentType("x.__proto__")).toBe("application/octet-stream");
    expect(uploadContentType("x.toString")).toBe("application/octet-stream");
  });

  it("calea se reduce la basename înainte de extensie", () => {
    expect(uploadContentType("../../x.pdf")).toBe("application/pdf");
  });
});
