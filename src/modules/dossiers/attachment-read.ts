import OpenAI from "openai";
import { responsesParams } from "../../lib/openai-models.js";
import { env } from "../../config/env.js";
import { collectOutputText, extractJsonBlock } from "../documents/documents-parse.service.js";

/**
 * Citirea documentelor atașate la dosar — facturi, certificate de calitate, declarații
 * de conformitate (țeavă, fitinguri, raiser) și avize — cu modelul de viziune. Răspunsul
 * se normalizează în `lib/material-doc.ts`; pagina Dosare completează doar câmpurile
 * goale și arată ce a pus.
 */
export { normalizeMaterialDoc, type MaterialDocData, type MaterialDocKind } from "../../lib/material-doc.js";
import { normalizeMaterialDoc, type MaterialDocData } from "../../lib/material-doc.js";

const SYSTEM = `Ești un asistent care citește documente de însoțire a materialelor pentru lucrări de gaze naturale din România:
facturi, certificate de calitate, declarații de conformitate (țeavă PE100 / OL, mufe, teuri, raisere, robinete) și avize (Electrica, Apă-Canal, Telekom, drumuri etc.).
Răspunzi EXCLUSIV cu un obiect JSON valid, fără text în plus.`;

const USER = `Extrage din document, în JSON:
{
  "tip_document": "factura" | "certificat_calitate" | "declaratie_conformitate" | "aviz" | "altul",
  "furnizor": "firma care a emis documentul / furnizorul materialului",
  "certificat_calitate": { "nr": "...", "data": "zz.ll.aaaa" } sau null,
  "declaratie_conformitate": { "nr": "...", "data": "zz.ll.aaaa" } sau null,
  "factura": { "nr": "...", "data": "zz.ll.aaaa" } sau null,
  "lot": "lotul / șarja, dacă apare",
  "materiale": [ { "denumire": "ex. Teava PE100 SDR11", "diametru": "ex. 63 sau 2\\"", "cantitate": "ex. 724", "um": "ml / buc" } ],
  "aviz": { "denumire": "ex. Aviz Electrica", "emitent": "...", "nr": "...", "data": "zz.ll.aaaa" } sau null
}
Un certificat poate conține și declarația de conformitate — completează-le pe amândouă dacă apar.
Lasă gol ("") sau null ce nu apare în document; nu inventa numere.`;

export const MATERIAL_DOC_MIME = ["application/pdf", "image/png", "image/jpeg", "image/jpg", "image/webp", "image/heic"];

export async function readMaterialDoc(input: { buffer: Buffer; mimetype: string; filename: string }): Promise<MaterialDocData> {
  if (!env.OPENAI_API_KEY) throw new Error("Citirea automată nu e configurată (lipsește cheia OpenAI).");
  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const dataUrl = `data:${input.mimetype};base64,${input.buffer.toString("base64")}`;
  const content = input.mimetype.startsWith("image/")
    ? [{ type: "input_image", image_url: dataUrl, detail: "high" }, { type: "input_text", text: USER }]
    : [{ type: "input_file", filename: input.filename, file_data: dataUrl }, { type: "input_text", text: USER }];
  const response = await openai.responses.create({
    ...responsesParams(env.OPENAI_MODEL_VISION, { temperature: 0.1, maxOutputTokens: 2000 }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: [{ role: "user", content: content as any }],
    instructions: SYSTEM,
  });
  const text = collectOutputText(response);
  if (!text) throw new Error("Modelul nu a returnat niciun răspuns.");
  return normalizeMaterialDoc(JSON.parse(extractJsonBlock(text)));
}
