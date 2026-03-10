import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";

export function renderDocx(
  templateBuffer: Buffer,
  data: Record<string, unknown>
): Buffer {
  const zip = new PizZip(templateBuffer);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
  });

  doc.render(data);

  return Buffer.from(
    doc.getZip().generate({
      type: "nodebuffer",
      compression: "DEFLATE",
    })
  );
}
