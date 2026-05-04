import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import ImageModule from "docxtemplater-image-module-free";

export function renderDocx(
  templateBuffer: Buffer,
  data: Record<string, unknown>,
  images?: Record<string, Buffer>
): Buffer {
  const zip = new PizZip(templateBuffer);

  const modules: any[] = [];
  if (images && Object.keys(images).length > 0) {
    modules.push(
      new ImageModule({
        centered: false,
        getImage: (tagValue: string) => images[tagValue] || Buffer.alloc(0),
        getSize: () => [570, 380], // ~15cm x 10cm at 72dpi
      })
    );
  }

  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    modules,
  });

  doc.render(data);

  return Buffer.from(
    doc.getZip().generate({
      type: "nodebuffer",
      compression: "DEFLATE",
    })
  );
}
