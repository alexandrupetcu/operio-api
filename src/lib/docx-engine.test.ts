import { describe, expect, it } from "vitest";
import PizZip from "pizzip";
import { renderDocx, EMPTY_FIELD } from "./docx-engine.js";

/** Un DOCX minimal cu un singur paragraf de text (Word ar sparge textul în run-uri; aici nu contează). */
function docx(text: string): Buffer {
  const zip = new PizZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generate({ type: "nodebuffer" });
}
const textOf = (buf: Buffer) => new PizZip(buf).file("word/document.xml")!.asText().replace(/<[^>]+>/g, "");

describe("renderDocx — câmpuri necompletate", () => {
  it("un câmp text lipsă se tipărește ca linie punctată, nu „undefined”", () => {
    const out = textOf(renderDocx(docx("Autorizatie nr. {autorizatie_construire_nr} din {autorizatie_construire_data}, DN {project_dn}"), { project_dn: "32" }));
    expect(out).not.toContain("undefined");
    expect(out).toBe(`Autorizatie nr. ${EMPTY_FIELD} din ${EMPTY_FIELD}, DN 32`);
  });

  it("o imagine lipsă (firma fără logo, fără modulul de imagini) nu lasă nimic în urmă", () => {
    const out = textOf(renderDocx(docx("[{%tenant_logo}] {tenant_name}"), { tenant_name: "Firma" }));
    expect(out).toBe("[] Firma");
  });

  it("o buclă fără date (tabelul sudorilor gol) nu tipărește nimic", () => {
    const out = textOf(renderDocx(docx("A{#project_sudori}{sudor_ol_nume};{/project_sudori}B"), {}));
    expect(out).toBe("AB");
  });

  it("o valoare goală explicită rămâne goală (operatorul a șters intenționat)", () => {
    expect(textOf(renderDocx(docx("[{cod_sap}]"), { cod_sap: "" }))).toBe("[]");
  });
});

describe("renderDocx — spațiile de nume pentru imagini", () => {
  it("un șablon fără xmlns:r / xmlns:wp pe rădăcină primește declarațiile (altfel Word refuză documentul cu imagine)", () => {
    const zip = new PizZip(docx("{%semnatura}"));
    zip.file("word/_rels/document.xml.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const out = renderDocx(zip.generate({ type: "nodebuffer" }), { semnatura: "sig" }, { sig: png });
    const xml = new PizZip(out).file("word/document.xml")!.asText();
    expect(xml).toContain("r:embed");
    const root = xml.slice(xml.indexOf("<w:document"), xml.indexOf(">", xml.indexOf("<w:document")));
    expect(root).toContain('xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"');
    expect(root).toContain('xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"');
  });

  it("mai multe imagini primesc identificatori docPr diferiți (cu același id, Word refuză PV-ul cu 3 semnături)", () => {
    const zip = new PizZip(docx("{%a}"));
    const paras = ["a", "b", "c"].map((k) => `<w:p><w:r><w:t>{%${k}}</w:t></w:r></w:p>`).join("");
    zip.file("word/document.xml", zip.file("word/document.xml")!.asText().replace(/<w:body>.*<\/w:body>/, `<w:body>${paras}</w:body>`));
    zip.file("word/_rels/document.xml.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const out = renderDocx(zip.generate({ type: "nodebuffer" }), { a: "x", b: "y", c: "z" }, { x: png, y: png, z: png });
    const ids = [...new PizZip(out).file("word/document.xml")!.asText().matchAll(/<wp:docPr id="(\d+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });
});
