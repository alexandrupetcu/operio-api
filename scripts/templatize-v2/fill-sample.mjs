// Fill a DOCX template with sample data using the SAME docxtemplater options as
// src/lib/docx-engine.ts (delimiters { }, paragraphLoop, linebreaks, „..........”
// for missing text, images via docxtemplater-image-module-free).
//
//   node scripts/templatize-v2/fill-sample.mjs <data.json> <images-dir> <in.docx> <out.docx> [<in2> <out2> …]
//
// Prints one JSON line per file: {file, ok, error?, tags:[…]}.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.cwd(), "package.json"));
const Docxtemplater = require("docxtemplater");
const PizZip = require("pizzip");
const ImageModule = require("docxtemplater-image-module-free");
const InspectModule = require("docxtemplater/js/inspect-module.js");

const [dataPath, imgDir, ...pairs] = process.argv.slice(2);
const data = JSON.parse(readFileSync(dataPath, "utf8"));
// Sizes as in DOCX_IMAGE_OPTS of the worker.
const SIZES = { tenant_logo: [155, 80], project_drawing: [560, 360], project_drawing_mic: [520, 280], tenant_signature: [200, 90] };
const images = {};
for (const k of Object.keys(SIZES)) {
  const p = join(imgDir, `${k}.png`);
  if (existsSync(p)) { images[k] = readFileSync(p); data[k] = k; }
}

function nullGetter(part) {
  if (part.module) return "";
  if (typeof part.value === "string" && part.value.startsWith("%")) return "";
  return "..........";
}

for (let i = 0; i < pairs.length; i += 2) {
  const [src, dst] = [pairs[i], pairs[i + 1]];
  const res = { file: src, ok: true };
  try {
    const iModule = new InspectModule();
    const doc = new Docxtemplater(new PizZip(readFileSync(src)), {
      paragraphLoop: true,
      linebreaks: true,
      nullGetter,
      modules: [
        iModule,
        new ImageModule({
          centered: false,
          getImage: (v) => images[v] || Buffer.alloc(0),
          getSize: (_b, _v, tag) => SIZES[tag] ?? [570, 380],
        }),
      ],
    });
    res.tags = Object.keys(flatten(iModule.getAllTags()));
    doc.render(data);
    writeFileSync(dst, doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" }));
  } catch (e) {
    res.ok = false;
    const errs = e?.properties?.errors;
    res.error = errs ? errs.map((x) => `${x.properties?.id}: ${x.properties?.explanation}`).join("; ") : String(e?.message ?? e);
  }
  console.log(JSON.stringify(res));
}

function flatten(tags, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(tags)) {
    out[prefix + k] = true;
    if (v && typeof v === "object" && Object.keys(v).length) flatten(v, `${prefix}${k}.`, out);
  }
  return out;
}
