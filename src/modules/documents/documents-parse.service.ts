import OpenAI from "openai";
import { Prisma } from "@prisma/client";
import type { MultipartFile } from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { env } from "../../config/env.js";

export interface AvizItem {
  nume: string;
  emitent?: string;
  categorie?: string;
  observatii?: string;
  alternativa?: string;
  incert?: boolean;
}

export interface DocumentItem {
  nume: string;
  categorie?: string;
  descriere?: string;
  incert?: boolean;
}

export interface ChecklistCategorie {
  titlu: string;
  items: string[];
}

export interface ParsePermitsResult {
  avize: AvizItem[];
  documente: DocumentItem[];
  checklist: ChecklistCategorie[];
  rezumat: string;
}

/**
 * Robust text collector for the Responses API output. Prefers the SDK's
 * built-in `output_text` accessor, but falls back to walking the raw output
 * items and joining every `output_text` content part. Some SDK versions
 * return an empty `output_text` when the response has reasoning-summary
 * items mixed in with the message.
 */
function collectOutputText(response: {
  output_text?: string | null;
  output?: unknown;
}): string {
  const primary = response.output_text?.trim();
  if (primary) return primary;
  const items = Array.isArray(response.output) ? (response.output as unknown[]) : [];
  const parts: string[] = [];
  for (const item of items) {
    const rec = item as Record<string, unknown>;
    if (rec.type !== "message") continue;
    const content = Array.isArray(rec.content) ? (rec.content as unknown[]) : [];
    for (const c of content) {
      const crec = c as Record<string, unknown>;
      if (crec.type === "output_text" && typeof crec.text === "string") {
        parts.push(crec.text);
      }
    }
  }
  return parts.join("").trim();
}

/**
 * Best-effort JSON extraction from a model response. Handles three failure
 * modes we've seen in practice:
 *   1. `json` fenced code blocks (```json ... ```)
 *   2. bare markdown fences (``` ... ```)
 *   3. models adding a natural-language preamble/postscript ("Iată rezultatul: {...}")
 * For (3) we grab everything between the first `{` and the matching last `}`.
 */
function extractJsonBlock(rawText: string): string {
  // Strip fences first — cheap and covers the common case.
  const fencedMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fencedMatch?.[1] ?? rawText).trim();
  // If the candidate already parses as JSON we're done; otherwise pull the
  // substring between the first `{` and the last `}` — the model may have
  // added prose before/after the JSON object.
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    const first = candidate.indexOf("{");
    const last = candidate.lastIndexOf("}");
    if (first >= 0 && last > first) return candidate.slice(first, last + 1);
    return candidate;
  }
}

const SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "text/plain",
];

const SYSTEM_PROMPT = `Ești un expert în legislația română privind autorizațiile de construire.
Analizezi certificate de urbanism scanate și alte documente oficiale și extragi structurat toate avizele, acordurile și documentele necesare.
Răspunzi EXCLUSIV în format JSON valid, fără text suplimentar, fără markdown fences.

Schema JSON:
{
  "avize": [
    {
      "nume": "string — denumirea avizului/acordului fidel documentului",
      "emitent": "string — instituția emitentă dacă e menționată",
      "categorie": "string — una din: documente_de_baza | avize_utilitati | avize_speciale | avize_administrative | mediu | studii_verificari | taxe_observatii",
      "observatii": "string (opțional) — detalii suplimentare",
      "alternativa": "string (opțional) — dacă există formulare alternativă (ex. acord proprietari SAU adresă primărie)",
      "incert": true/false — marchează cu true dacă textul era greu lizibil
    }
  ],
  "documente": [
    {
      "nume": "string",
      "categorie": "string — aceleași categorii ca mai sus",
      "descriere": "string (opțional)",
      "incert": true/false
    }
  ],
  "checklist": [
    {
      "titlu": "string — una din: De pregătit întâi | De cerut de la instituții | De obținut ca acorduri/confirmări | De verificat înainte de depunere | Dosarul final de depus",
      "items": ["string", ...]
    }
  ],
  "rezumat": "string — scurt rezumat: tipul lucrării, adresa, emitentul certificatului, număr/dată dacă e vizibil"
}

Reguli stricte:
- Nu inventa informații care nu apar în document
- Păstrează denumirile instituțiilor și avizelor cât mai fidel documentului
- Marchează cu incert: true elementele greu lizibile și adaugă [de verificat în document] în câmpul observatii
- Dacă există formulări alternative (SAU / sau), completează câmpul alternativa
- Răspuns în limba română`;

const USER_PROMPT = `Analizează documentul PDF atașat, care este un certificat de urbanism scanat.

Extrage din document toate avizele, acordurile și documentele necesare pentru obținerea autorizației, exact cum apar în document.

Separă informația în categorii:
- documente_de_baza
- avize_utilitati
- avize_speciale
- avize_administrative
- mediu
- studii_verificari
- taxe_observatii

Generează și un checklist practic grupat în:
a) De pregătit întâi
b) De cerut de la instituții
c) De obținut ca acorduri/confirmări
d) De verificat înainte de depunere
e) Dosarul final de depus

Returnează rezultatul strict în formatul JSON descris în instrucțiuni.`;

export async function parsePermits(
  fastify: FastifyInstance,
  file: MultipartFile
): Promise<ParsePermitsResult> {
  if (!env.OPENAI_API_KEY) {
    throw fastify.httpErrors.serviceUnavailable(
      "OpenAI API key nu este configurat"
    );
  }

  if (!SUPPORTED_MIME_TYPES.includes(file.mimetype)) {
    throw fastify.httpErrors.badRequest(
      `Tip de fișier nesuportat: ${file.mimetype}. Sunt acceptate: PDF, DOCX, DOC, TXT.`
    );
  }

  const buffer = await file.toBuffer();
  if (buffer.length === 0) {
    throw fastify.httpErrors.badRequest("Fișierul este gol.");
  }

  const maxSizeBytes = 20 * 1024 * 1024; // 20MB
  if (buffer.length > maxSizeBytes) {
    throw fastify.httpErrors.badRequest(
      "Fișierul depășește limita de 20MB."
    );
  }

  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  const base64 = buffer.toString("base64");
  const fileData = `data:${file.mimetype};base64,${base64}`;

  const response = await openai.responses.create({
    model: "gpt-4.1",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_file",
            filename: file.filename,
            file_data: fileData,
          },
          {
            type: "input_text",
            text: USER_PROMPT,
          },
        ],
      },
    ],
    instructions: SYSTEM_PROMPT,
    temperature: 0.1,
    // Long certificates can produce a lot of JSON — the SDK's default cap
    // (~2048 in some builds) truncates mid-object, which then fails JSON.parse
    // and looks like "the model returned garbage". Give it generous headroom.
    max_output_tokens: 8000,
  });

  const rawText = collectOutputText(response);
  if (!rawText) {
    fastify.log.error(
      { responseId: response.id, status: response.status },
      "parsePermits: model returned empty output_text",
    );
    throw fastify.httpErrors.internalServerError(
      "Modelul nu a returnat niciun răspuns.",
    );
  }

  const cleaned = extractJsonBlock(rawText);
  let result: ParsePermitsResult;
  try {
    result = JSON.parse(cleaned);
  } catch (err) {
    // Full raw text logged so we can see WHY it failed the next time — the
    // most common causes are: model added a preamble ("Iată rezultatul..."),
    // model wrapped in ```json``` fences we didn't strip, or the response
    // was truncated mid-object because of max_output_tokens.
    fastify.log.error(
      {
        responseId: response.id,
        status: response.status,
        rawTextLength: rawText.length,
        rawTextHead: rawText.slice(0, 400),
        rawTextTail: rawText.slice(-200),
        cleanedHead: cleaned.slice(0, 400),
        error: (err as Error).message,
      },
      "parsePermits: model response was not valid JSON",
    );
    throw fastify.httpErrors.internalServerError(
      "Răspunsul modelului nu este JSON valid. Încearcă din nou.",
    );
  }

  // Normalize — ensure arrays exist
  return {
    avize: Array.isArray(result.avize) ? result.avize : [],
    documente: Array.isArray(result.documente) ? result.documente : [],
    checklist: Array.isArray(result.checklist) ? result.checklist : [],
    rezumat: result.rezumat ?? "",
  };
}

// ── Autorizație de construire ──────────────────────────────────────────────

export interface AuthorizationData {
  autorizatie_construire_nr: string;
  autorizatie_construire_data: string;
  autorizatie_construire_emitent: string;
}

const AUTH_SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/webp",
];

const AUTH_SYSTEM_PROMPT = `Ești un expert în autorizații de construire emise de primării/consilii din România.
Analizezi o autorizație de construire (PDF sau scanată ca imagine) și extragi exact trei informații.
Răspunzi EXCLUSIV în format JSON valid, fără text suplimentar, fără markdown fences.

Schema JSON:
{
  "autorizatie_construire_nr": "string — numărul autorizației de construire (doar valoarea, fără cuvântul \\"nr.\\"; păstrează literele/sufixele dacă fac parte din număr)",
  "autorizatie_construire_data": "string — data emiterii, format DD.MM.YYYY",
  "autorizatie_construire_emitent": "string — instituția emitentă (ex. \\"Primăria Măgurele\\", \\"Consiliul Județean Ilfov\\")"
}

Reguli stricte:
- Nu inventa informații. Dacă un câmp nu apare în document, pune string gol "".
- Data în format DD.MM.YYYY.
- Răspuns în limba română.`;

const AUTH_USER_PROMPT = `Analizează documentul atașat — o autorizație de construire — și extrage numărul autorizației, data emiterii și instituția emitentă (primăria/consiliul). Returnează strict JSON în formatul descris.`;

/** Extract the building-authorization fields from an uploaded file via GPT-4.1. */
export async function parseAuthorization(
  fastify: FastifyInstance,
  file: MultipartFile
): Promise<AuthorizationData> {
  if (!env.OPENAI_API_KEY) {
    throw fastify.httpErrors.serviceUnavailable("OpenAI API key nu este configurat");
  }
  if (!AUTH_SUPPORTED_MIME_TYPES.includes(file.mimetype)) {
    throw fastify.httpErrors.badRequest(
      `Tip de fișier nesuportat: ${file.mimetype}. Sunt acceptate: PDF, DOCX, DOC, TXT, PNG, JPG, WEBP.`
    );
  }

  const buffer = await file.toBuffer();
  if (buffer.length === 0) throw fastify.httpErrors.badRequest("Fișierul este gol.");
  if (buffer.length > 20 * 1024 * 1024) throw fastify.httpErrors.badRequest("Fișierul depășește limita de 20MB.");

  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const dataUrl = `data:${file.mimetype};base64,${buffer.toString("base64")}`;
  const isImage = file.mimetype.startsWith("image/");
  const content = isImage
    ? [
        { type: "input_image", image_url: dataUrl, detail: "auto" },
        { type: "input_text", text: AUTH_USER_PROMPT },
      ]
    : [
        { type: "input_file", filename: file.filename, file_data: dataUrl },
        { type: "input_text", text: AUTH_USER_PROMPT },
      ];

  const response = await openai.responses.create({
    model: "gpt-4.1",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: [{ role: "user", content: content as any }],
    instructions: AUTH_SYSTEM_PROMPT,
    temperature: 0.1,
    max_output_tokens: 1000,
  });

  const rawText = collectOutputText(response);
  if (!rawText) {
    fastify.log.error(
      { responseId: response.id, status: response.status },
      "parseAuthorization: model returned empty output_text",
    );
    throw fastify.httpErrors.internalServerError("Modelul nu a returnat niciun răspuns.");
  }

  const cleaned = extractJsonBlock(rawText);
  let parsed: Partial<AuthorizationData>;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    fastify.log.error(
      {
        responseId: response.id,
        rawTextHead: rawText.slice(0, 400),
        rawTextTail: rawText.slice(-200),
        cleanedHead: cleaned.slice(0, 400),
        error: (err as Error).message,
      },
      "parseAuthorization: model response was not valid JSON",
    );
    throw fastify.httpErrors.internalServerError("Răspunsul modelului nu este JSON valid. Încearcă din nou.");
  }

  return {
    autorizatie_construire_nr: String(parsed.autorizatie_construire_nr ?? "").trim(),
    autorizatie_construire_data: String(parsed.autorizatie_construire_data ?? "").trim(),
    autorizatie_construire_emitent: String(parsed.autorizatie_construire_emitent ?? "").trim(),
  };
}

/**
 * Parse a building authorization and save the extracted fields onto the
 * project's metadata (merging, so unrelated keys like `value` are kept).
 */
export async function parseAndSaveAuthorization(
  fastify: FastifyInstance,
  tenantId: string,
  projectId: string,
  file: MultipartFile
): Promise<AuthorizationData> {
  const project = await fastify.prisma.project.findFirst({ where: { id: projectId, tenantId } });
  if (!project) throw fastify.httpErrors.notFound("Project not found");

  const extracted = await parseAuthorization(fastify, file);

  const meta =
    project.metadata && typeof project.metadata === "object"
      ? { ...(project.metadata as Record<string, unknown>) }
      : {};
  for (const [key, value] of Object.entries(extracted)) {
    if (value) meta[key] = value; // only overwrite with non-empty extracted values
  }

  await fastify.prisma.project.update({
    where: { id: projectId },
    data: { metadata: meta as Prisma.InputJsonValue },
  });

  return extracted;
}

// ─── Gas bill (factură gaze naturale) parser ─────────────────────────────────

/** Data extracted from a customer's gas bill — used to autofill GasInstallation. */
export interface GasBillData {
  // Distribution / supply identity
  distributorName: string | null; // Operator Sistem (Distrigaz/Delgaz/...)
  supplierName: string | null;    // Furnizor (ENGIE, E.ON, ...) — informational
  // Installation identifiers
  codTehnicPOD: string | null;    // Cod loc consum / CLC / POD
  codClient: string | null;       // Cod client
  installationAddress: string | null; // Adresa locului de consum
  // Contracts (informational only — different from the revizie/verificare service contract)
  supplyContractNumber: string | null;
  supplyContractDate: string | null;     // DD.MM.YYYY
  servicesContractNumber: string | null;
  servicesContractDate: string | null;   // DD.MM.YYYY
  // Meter (contor) — serie usually formatted "<Producator>/<Nr>/<An>"
  contorSeria: string | null;
  contorNr: string | null;
  contorAn: string | null;
  contorIndex: string | null;
  // Context
  periodFrom: string | null;
  periodTo: string | null;
  categorieConsum: string | null;
  clientName: string | null;
}

const GAS_BILL_SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
];

const GAS_BILL_SYSTEM_PROMPT = `Ești un expert în facturi de gaze naturale emise în România (ENGIE, E.ON, OMV, Premier Energy, etc.).
Analizezi o factură (PDF sau scanată) și extragi datele de identificare ale instalației de utilizare.
Răspunzi EXCLUSIV în format JSON valid, fără text suplimentar, fără markdown fences.

Schema JSON (toate câmpurile pot fi null dacă nu apar în document):
{
  "distributorName": "string|null — OPERATORUL SISTEMULUI DE DISTRIBUȚIE (ex. \\"Distrigaz Sud Rețele\\", \\"Delgaz Grid\\"). NU furnizorul (ENGIE/E.ON).",
  "supplierName": "string|null — FURNIZORUL (ex. \\"ENGIE Romania S.A.\\", \\"E.ON Energie\\")",
  "codTehnicPOD": "string|null — codul tehnic / Cod loc consum (CLC) / POD (ex. \\"DGSBSC103257180\\")",
  "codClient": "string|null — codul de client (ex. \\"191075652021\\")",
  "installationAddress": "string|null — adresa locului de consum",
  "supplyContractNumber": "string|null — numărul contractului de furnizare gaze",
  "supplyContractDate": "string|null — data contractului de furnizare, format DD.MM.YYYY",
  "servicesContractNumber": "string|null — numărul contractului de servicii (dacă apare separat)",
  "servicesContractDate": "string|null — data contractului de servicii, format DD.MM.YYYY",
  "contorSeria": "string|null — partea de PRODUCĂTOR/SERIE a seriei contorului (ex. dacă seria e \\"DGSR/00004930/2021\\", aici e \\"DGSR\\")",
  "contorNr": "string|null — partea de NUMĂR a seriei contorului (ex. \\"00004930\\")",
  "contorAn": "string|null — partea de AN a seriei contorului (ex. \\"2021\\")",
  "contorIndex": "string|null — indexul nou (curent) al contorului, în mc (ex. \\"4.747\\")",
  "periodFrom": "string|null — început perioadă facturare, format DD.MM.YYYY",
  "periodTo": "string|null — sfârșit perioadă facturare, format DD.MM.YYYY",
  "categorieConsum": "string|null — categoria de consum (ex. \\"C1.2\\")",
  "clientName": "string|null — numele clientului (persoană fizică sau juridică)"
}

Reguli stricte:
- Nu inventa. Dacă un câmp nu apare în document, pune null (NU string gol).
- Distinge clar Operator Sistem (distributor) de Furnizor (supplier): Distrigaz/Delgaz/E.ON Distribuție sunt OS; ENGIE/E.ON Energie/OMV Petrom Gas sunt furnizori.
- Seria contorului are frecvent forma "PRODUCATOR/NUMAR/AN" (ex. "DGSR/00004930/2021") — split în trei câmpuri.
- Datele în format DD.MM.YYYY.
- Răspuns în limba română.`;

const GAS_BILL_USER_PROMPT = `Analizează factura atașată de gaze naturale și extrage datele de identificare ale instalației și ale contorului. Returnează strict JSON în formatul descris.`;

/** Extract identity fields from a gas bill (PDF/image) via GPT-4.1 — does NOT save anything. */
export async function parseGasBill(
  fastify: FastifyInstance,
  file: MultipartFile
): Promise<GasBillData> {
  if (!env.OPENAI_API_KEY) {
    throw fastify.httpErrors.serviceUnavailable("OpenAI API key nu este configurat");
  }
  if (!GAS_BILL_SUPPORTED_MIME_TYPES.includes(file.mimetype)) {
    throw fastify.httpErrors.badRequest(
      `Tip de fișier nesuportat: ${file.mimetype}. Sunt acceptate: PDF, PNG, JPG, WEBP.`
    );
  }

  const buffer = await file.toBuffer();
  if (buffer.length === 0) throw fastify.httpErrors.badRequest("Fișierul este gol.");
  if (buffer.length > 20 * 1024 * 1024) throw fastify.httpErrors.badRequest("Fișierul depășește limita de 20MB.");

  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const dataUrl = `data:${file.mimetype};base64,${buffer.toString("base64")}`;
  const isImage = file.mimetype.startsWith("image/");
  // Phone-camera shots of a paper bill are dense with small text; "auto" detail
  // often downscales and drops fields. Force "high" so the model OCR's at full res.
  const content = isImage
    ? [
        { type: "input_image", image_url: dataUrl, detail: "high" },
        { type: "input_text", text: GAS_BILL_USER_PROMPT },
      ]
    : [
        { type: "input_file", filename: file.filename, file_data: dataUrl },
        { type: "input_text", text: GAS_BILL_USER_PROMPT },
      ];

  const response = await openai.responses.create({
    model: "gpt-4.1",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: [{ role: "user", content: content as any }],
    instructions: GAS_BILL_SYSTEM_PROMPT,
    temperature: 0.1,
    max_output_tokens: 2000,
  });

  const rawText = collectOutputText(response);
  if (!rawText) {
    fastify.log.error(
      { responseId: response.id, status: response.status },
      "parseGasBill: model returned empty output_text",
    );
    throw fastify.httpErrors.internalServerError("Modelul nu a returnat niciun răspuns.");
  }

  const cleaned = extractJsonBlock(rawText);
  let parsed: Partial<GasBillData>;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    fastify.log.error(
      {
        responseId: response.id,
        rawTextHead: rawText.slice(0, 400),
        rawTextTail: rawText.slice(-200),
        cleanedHead: cleaned.slice(0, 400),
        error: (err as Error).message,
      },
      "parseGasBill: model response was not valid JSON",
    );
    throw fastify.httpErrors.internalServerError("Răspunsul modelului nu este JSON valid.");
  }

  // Normalize: trim strings, treat empty strings as null.
  const norm = (v: unknown): string | null => {
    if (v == null) return null;
    const s = String(v).trim();
    return s.length === 0 ? null : s;
  };

  return {
    distributorName: norm(parsed.distributorName),
    supplierName: norm(parsed.supplierName),
    codTehnicPOD: norm(parsed.codTehnicPOD),
    codClient: norm(parsed.codClient),
    installationAddress: norm(parsed.installationAddress),
    supplyContractNumber: norm(parsed.supplyContractNumber),
    supplyContractDate: norm(parsed.supplyContractDate),
    servicesContractNumber: norm(parsed.servicesContractNumber),
    servicesContractDate: norm(parsed.servicesContractDate),
    contorSeria: norm(parsed.contorSeria),
    contorNr: norm(parsed.contorNr),
    contorAn: norm(parsed.contorAn),
    contorIndex: norm(parsed.contorIndex),
    periodFrom: norm(parsed.periodFrom),
    periodTo: norm(parsed.periodTo),
    categorieConsum: norm(parsed.categorieConsum),
    clientName: norm(parsed.clientName),
  };
}
