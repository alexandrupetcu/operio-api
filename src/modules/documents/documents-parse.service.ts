import OpenAI from "openai";
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
  });

  const rawText = response.output_text?.trim();
  if (!rawText) {
    throw fastify.httpErrors.internalServerError(
      "Modelul nu a returnat niciun răspuns."
    );
  }

  // Strip markdown fences if the model ignores instructions
  const cleaned = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");

  let result: ParsePermitsResult;
  try {
    result = JSON.parse(cleaned);
  } catch {
    throw fastify.httpErrors.internalServerError(
      "Răspunsul modelului nu este JSON valid. Încearcă din nou."
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
