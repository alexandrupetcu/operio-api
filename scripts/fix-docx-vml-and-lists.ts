/**
 * Fix two legacy-Word artefacts that prevent modern renderers from displaying
 * a docx correctly:
 *
 *   1. **VML images → DrawingML.** Old Word files reference embedded images via
 *      `<w:pict><v:shape><v:imagedata r:id="…"/></v:shape></w:pict>`. Most
 *      modern docx renderers (Puppeteer/LibreOffice headless, docxtemplater,
 *      browser previews) ignore or break on VML. We rewrite each such block as
 *      the equivalent `<w:drawing><wp:inline>…<a:blip r:embed="…"/>…</wp:inline></w:drawing>`,
 *      preserving the relationship id (so `word/_rels/{header,document,footer}*.xml.rels`
 *      doesn't need to change) and the width/height (read from the v:shape style).
 *
 *   2. **Auto-numbering on Heading2/list paragraphs.** Some templates apply
 *      `<w:numPr>` either via the style definition or directly on `<w:pPr>`,
 *      which makes Word/the renderer prepend "1.", "2.", "•" automatically.
 *      We strip every `<w:numPr>` in document.xml, header*.xml, footer*.xml AND
 *      in styles.xml — the latter is what causes Heading2 paragraphs to render
 *      as a list even when no numbering was explicitly applied in the body.
 *
 * Output: writes `<input>-fixed.docx` next to the original; never overwrites.
 * The relationships file is left untouched (we reuse the same r:id).
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/fix-docx-vml-and-lists.ts \
 *     "../documente/Carte Bransament Templates/9.) FD 346 103 Fisa tehnica SR-PR  DGSR (x1).docx"
 */

import PizZip from "pizzip";
import { readFileSync, writeFileSync } from "fs";
import { basename, extname, join, dirname } from "path";

/** Word uses English Metric Units (EMU) for DrawingML sizes — 1 point = 12700 EMU. */
const ptToEmu = (pt: number) => Math.round(pt * 12700);

/**
 * Rewrite every `<w:pict>…</w:pict>` that contains a `<v:imagedata>` as a
 * DrawingML inline picture. Non-image picts (rare in modern files) pass through
 * untouched.
 */
function convertVmlToDrawingML(xml: string): { xml: string; changed: number } {
  let changed = 0;
  const out = xml.replace(/<w:pict\b[^>]*>([\s\S]*?)<\/w:pict>/g, (full, inner) => {
    const imgIdMatch = inner.match(/<v:imagedata\b[^>]*?r:id="([^"]+)"/);
    if (!imgIdMatch) return full;
    const rId = imgIdMatch[1];

    const styleMatch = inner.match(/<v:shape\b[^>]*?\sstyle="([^"]+)"/);
    let widthPt = 100;
    let heightPt = 50;
    if (styleMatch) {
      const style = styleMatch[1];
      const wMatch = style.match(/width:\s*([\d.]+)pt/);
      const hMatch = style.match(/height:\s*([\d.]+)pt/);
      if (wMatch) widthPt = parseFloat(wMatch[1]);
      if (hMatch) heightPt = parseFloat(hMatch[1]);
    }
    const cx = ptToEmu(widthPt);
    const cy = ptToEmu(heightPt);
    changed++;

    // Namespaces are declared inline so the snippet is self-contained even if
    // the host part doesn't declare wp / a / pic. (r: is always declared on
    // the root w:hdr/w:document, so r:embed below resolves correctly.)
    return (
      `<w:drawing>` +
        `<wp:inline distT="0" distB="0" distL="0" distR="0" ` +
          `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
          `<wp:extent cx="${cx}" cy="${cy}"/>` +
          `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
          `<wp:docPr id="1" name="Picture 1"/>` +
          `<wp:cNvGraphicFramePr>` +
            `<a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>` +
          `</wp:cNvGraphicFramePr>` +
          `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
            `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
              `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
                `<pic:nvPicPr><pic:cNvPr id="1" name="Picture 1"/><pic:cNvPicPr/></pic:nvPicPr>` +
                `<pic:blipFill>` +
                  `<a:blip r:embed="${rId}"/>` +
                  `<a:stretch><a:fillRect/></a:stretch>` +
                `</pic:blipFill>` +
                `<pic:spPr>` +
                  `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
                  `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
                `</pic:spPr>` +
              `</pic:pic>` +
            `</a:graphicData>` +
          `</a:graphic>` +
        `</wp:inline>` +
      `</w:drawing>`
    );
  });
  return { xml: out, changed };
}

/** Strip every `<w:numPr>…</w:numPr>` (and the self-closing variant). */
function stripNumPr(xml: string): { xml: string; changed: number } {
  let changed = 0;
  let out = xml.replace(/<w:numPr\b[^>]*>[\s\S]*?<\/w:numPr>/g, () => {
    changed++;
    return "";
  });
  out = out.replace(/<w:numPr\b[^/]*?\/>/g, () => {
    changed++;
    return "";
  });
  return { xml: out, changed };
}

function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: npx tsx scripts/fix-docx-vml-and-lists.ts <path/to/file.docx>");
    process.exit(1);
  }

  const zip = new PizZip(readFileSync(inputPath));

  let totalVml = 0;
  let totalNumPr = 0;

  // Body, headers, footers — and styles.xml because Heading2's *style definition*
  // is where the auto-numbering lives in this file. Stripping it only from the
  // body would leave Heading2 paragraphs still rendering as a list.
  const xmlPaths = Object.keys(zip.files).filter((p) =>
    /^word\/(document|header\d*|footer\d*|styles)\.xml$/.test(p)
  );

  for (const p of xmlPaths) {
    const before = zip.files[p].asText();
    let xml = before;
    let vmlChanges = 0;

    // Only headers/footers/document carry pictures — skip the VML scan in styles.xml.
    if (p !== "word/styles.xml") {
      const r = convertVmlToDrawingML(xml);
      xml = r.xml;
      vmlChanges = r.changed;
      totalVml += vmlChanges;
    }

    const np = stripNumPr(xml);
    xml = np.xml;
    totalNumPr += np.changed;

    if (xml !== before) {
      zip.file(p, xml);
      console.log(`  ~ ${p} (VML→DrawingML: ${vmlChanges}, numPr removed: ${np.changed})`);
    }
  }

  const dir = dirname(inputPath);
  const base = basename(inputPath, extname(inputPath));
  const ext = extname(inputPath);
  const outPath = join(dir, `${base}-fixed${ext}`);

  writeFileSync(outPath, zip.generate({ type: "nodebuffer", compression: "DEFLATE" }));

  console.log(`\nDone:`);
  console.log(`  VML images → DrawingML: ${totalVml}`);
  console.log(`  Auto-numbering tags removed: ${totalNumPr}`);
  console.log(`  Output: ${outPath}`);
}

main();
