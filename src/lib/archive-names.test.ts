import { describe, expect, it } from "vitest";
import { archiveEntryNames, originalFileName } from "./archive-names.js";

describe("numele documentelor din arhiva unui dosar", () => {
  it("folosește numele de fișier al șablonului (originalul clientului, cu numerotarea), altfel numele", () => {
    expect(
      archiveEntryNames([
        { name: "PV Control calitate", fileName: "5. PV Control calitate.docx" },
        { name: "Catre Distrigaz", fileName: "1.) Catre Distrigaz (x2).docx" },
        { name: "2. PV TRASARE AX CONDUCTA", fileName: null },
      ]),
    ).toEqual(["5. PV Control calitate.docx", "1.) Catre Distrigaz (x2).docx", "2. PV TRASARE AX CONDUCTA.docx"]);
  });

  it("nume repetate primesc un sufix, iar caracterele interzise în nume de fișier dispar", () => {
    expect(
      archiveEntryNames([
        { name: "PV", fileName: null },
        { name: "PV", fileName: null },
        { name: "PV a/b: c", fileName: null },
      ]),
    ).toEqual(["PV.docx", "PV (2).docx", "PV a-b- c.docx"]);
  });
});

describe("numele de fișier la încărcarea șabloanelor de sistem", () => {
  it("un șablon nou ia numele fișierului original; unul redenumit în aplicație își păstrează numele", () => {
    expect(originalFileName(null, "5. PV Control calitate.docx")).toBe("5. PV Control calitate.docx");
    expect(originalFileName("PV control (final).docx", "5. PV Control calitate.docx")).toBe("PV control (final).docx");
  });
});
