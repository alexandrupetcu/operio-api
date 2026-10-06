import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import ImageModule from "docxtemplater-image-module-free";

const EMU_PER_PX = 9525; // matches docxtemplater-image-module-free convertPixelsToEmus

export interface ImageRenderOptions {
  /** Fixed size in pixels per image tag, e.g. { tenant_signature: [200, 80] }. */
  sizes?: Record<string, [number, number]>;
  /** Fallback size (px) for image tags not in `sizes`. */
  defaultSize?: [number, number];
  /**
   * Tags rendered as a *floating* image placed "In Front of Text" (overlaps the
   * content below it, like a signature over a line) instead of inline — the
   * image does not shift surrounding text. Matched after render by their fixed
   * extent, so floated tags must have a `sizes` entry distinct from non-floated
   * images.
   */
  floatTags?: string[];
}

const POSITIONING =
  '<wp:simplePos x="0" y="0"/>' +
  '<wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH>' +
  '<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>';
// "In Front of Text": no wrapping (image overlaps content) + behindDoc="0".
const WRAP_NONE = "<wp:wrapNone/>";
const ANCHOR_ATTRS =
  'distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251658240" ' +
  'behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"';

/**
 * Rewrite inline image drawings whose extent matches one of `floatExtents`
 * (`"cx,cy"` in EMU) into floating anchored drawings placed "In Front of Text"
 * (overlap the content below). Inner picture XML (extent/effectExtent/docPr/
 * graphic) is preserved.
 */
function applyFloatInFront(xml: string, floatExtents: Set<string>): string {
  return xml.replace(/<wp:inline\b[^>]*>([\s\S]*?)<\/wp:inline>/g, (whole, inner: string) => {
    const m = inner.match(/<wp:extent\s+cx="(\d+)"\s+cy="(\d+)"\s*\/>/);
    if (!m || !floatExtents.has(`${m[1]},${m[2]}`)) return whole; // leave inline
    const innerFloated = POSITIONING + inner.replace(/(<wp:effectExtent\b[^>]*\/>)/, "$1" + WRAP_NONE);
    return `<wp:anchor ${ANCHOR_ATTRS}>${innerFloated}</wp:anchor>`;
  });
}

export function renderDocx(
  templateBuffer: Buffer,
  data: Record<string, unknown>,
  images?: Record<string, Buffer>,
  imageOpts?: ImageRenderOptions
): Buffer {
  const zip = new PizZip(templateBuffer);

  const modules: any[] = [];
  if (images && Object.keys(images).length > 0) {
    modules.push(
      new ImageModule({
        centered: false,
        getImage: (tagValue: string) => images[tagValue] || Buffer.alloc(0),
        getSize: (_img: Buffer, _tagValue: string, tagName: string) =>
          imageOpts?.sizes?.[tagName] ?? imageOpts?.defaultSize ?? [570, 380],
      })
    );
  }

  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    modules,
  });

  doc.render(data);

  // Convert configured image tags to floating "Through" wrap (post-render).
  const floatExtents = new Set(
    (imageOpts?.floatTags ?? [])
      .map((t) => imageOpts?.sizes?.[t])
      .filter((s): s is [number, number] => Array.isArray(s))
      .map(([w, h]) => `${Math.round(w * EMU_PER_PX)},${Math.round(h * EMU_PER_PX)}`)
  );
  if (floatExtents.size > 0) {
    const docXml = doc.getZip().file("word/document.xml");
    if (docXml) doc.getZip().file("word/document.xml", applyFloatInFront(docXml.asText(), floatExtents));
  }

  return Buffer.from(
    doc.getZip().generate({
      type: "nodebuffer",
      compression: "DEFLATE",
    })
  );
}
