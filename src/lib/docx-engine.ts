import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import ImageModule from "docxtemplater-image-module-free";

const EMU_PER_PX = 9525; // matches docxtemplater-image-module-free convertPixelsToEmus

/** Ce se tipărește pentru un câmp text necompletat: o linie de completat de mână. */
export const EMPTY_FIELD = "..........";

/**
 * Valoarea unui tag fără date. Implicit docxtemplater tipărește „undefined”.
 * Text → linie punctată; imagine (`{%…}`), buclă, raw XML → nimic.
 */
function nullGetter(part: { module?: string; value?: string; type?: string }): string {
  if (part.module) return ""; // bucle, imagini (cu modulul încărcat), raw XML
  if (typeof part.value === "string" && part.value.startsWith("%")) return ""; // imagine fără modul (firma n-are nicio imagine)
  return EMPTY_FIELD;
}

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

/** Prefixele folosite de imaginile inserate (modulul de imagini scrie `r:embed`, `wp:inline`). */
const IMAGE_NAMESPACES: [string, string][] = [
  ["r", "http://schemas.openxmlformats.org/officeDocument/2006/relationships"],
  ["wp", "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"],
  ["a", "http://schemas.openxmlformats.org/drawingml/2006/main"],
  ["pic", "http://schemas.openxmlformats.org/drawingml/2006/picture"],
];

/**
 * Unele șabloane (curățate de scripturi vechi) au pierdut declarațiile de pe rădăcină;
 * cu o imagine inserată, `r:embed` rămâne nedeclarat și Word refuză documentul.
 */
function ensureImageNamespaces(zip: PizZip): void {
  for (const name of Object.keys(zip.files)) {
    if (!/^word\/(document|header\d*|footer\d*)\.xml$/.test(name)) continue;
    const xml = zip.file(name)!.asText();
    const m = /<(w:document|w:hdr|w:ftr)\b[^>]*>/.exec(xml);
    if (!m) continue;
    const missing = IMAGE_NAMESPACES.filter(([p]) => !new RegExp(`\\sxmlns:${p}=`).test(m[0]));
    if (!missing.length) continue;
    const root = m[0].replace(/>$/, missing.map(([p, uri]) => ` xmlns:${p}="${uri}"`).join("") + ">");
    zip.file(name, xml.slice(0, m.index) + root + xml.slice(m.index + m[0].length));
  }
}

export function renderDocx(
  templateBuffer: Buffer,
  data: Record<string, unknown>,
  images?: Record<string, Buffer>,
  imageOpts?: ImageRenderOptions
): Buffer {
  const zip = new PizZip(templateBuffer);
  ensureImageNamespaces(zip);

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
    nullGetter,
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
