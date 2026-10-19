import { describe, expect, it } from "vitest";
import PizZip from "pizzip";
import { docxText, stampSlotsIn } from "./stamp-text.js";

describe("stampSlotsIn", () => {
  it("HTML și DOCX: slotul 1 e `tenant_stamp`, restul `tenant_stamp_N`", () => {
    expect([...stampSlotsIn("<img src='{{tenant_stamp}}'>")]).toEqual([1]);
    expect([...stampSlotsIn("{%tenant_stamp_2} și {%tenant_stamp_4}")].sort()).toEqual([2, 4]);
  });

  it("nu confundă variabile asemănătoare", () => {
    expect(stampSlotsIn("{{tenant_stamp_5}} {{tenant_stampila}} {{tenant_signature}}").size).toBe(0);
  });
});

describe("docxText", () => {
  it("lipește variabila spartă de Word în mai multe run-uri și citește antetul", () => {
    const zip = new PizZip();
    zip.file("word/document.xml", "<w:r><w:t>{%tenant_</w:t></w:r><w:r><w:t>stamp_3}</w:t></w:r>");
    zip.file("word/header1.xml", "<w:t>{%tenant_stamp}</w:t>");
    const buf = zip.generate({ type: "nodebuffer" });
    expect([...stampSlotsIn(docxText(buf))].sort()).toEqual([1, 3]);
  });
});
