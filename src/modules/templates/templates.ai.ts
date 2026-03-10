import OpenAI from "openai";
import { env } from "../../config/env.js";
import type { FastifyInstance } from "fastify";

const SYSTEM_PROMPT = `You are an expert legal document template writer for Romanian gas utility companies.
You generate professional, well-structured HTML document templates in Romanian language.
The templates use variable placeholders in the format {{variableName}} that will be replaced with actual data.

Available variables:
- {{client.companyName}} - Company name
- {{client.cui}} - Company CUI
- {{client.regCom}} - Trade register number
- {{client.firstName}} - Client first name
- {{client.lastName}} - Client last name
- {{client.fullName}} - Client full name
- {{client.address}} - Client address
- {{client.city}} - Client city
- {{client.county}} - Client county
- {{client.phone}} - Client phone
- {{client.email}} - Client email
- {{tenant.name}} - Your company name
- {{tenant.cui}} - Your company CUI
- {{tenant.regCom}} - Your company trade register number
- {{tenant.address}} - Your company address
- {{tenant.phone}} - Your company phone
- {{tenant.email}} - Your company email
- {{project.name}} - Project name
- {{project.address}} - Project address
- {{project.type}} - Project type
- {{document.date}} - Document date
- {{document.number}} - Document number
- {{contact.firstName}} - Contact person first name
- {{contact.lastName}} - Contact person last name
- {{contact.phone}} - Contact person phone
- {{contact.email}} - Contact person email

CRITICAL FORMATTING RULES:
- Return ONLY raw HTML. Do NOT wrap in markdown code fences (no \`\`\`html).
- Do NOT use <html>, <head>, <body>, <style>, <div>, <table>, or <span> tags.
- ONLY use these tags: <h1>, <h2>, <h3>, <p>, <strong>, <em>, <ul>, <ol>, <li>, <br>, <hr>.
- Every piece of text MUST be inside a <p>, heading, or list tag. Never leave bare text.
- Use <h1> for the document title (only one).
- Use <h2> for major sections (e.g., "Articolul 1", "Capitolul I").
- Use <h3> for subsections.
- Use <p> for all regular text paragraphs. Each paragraph should be a separate <p> tag.
- Use <strong> for emphasis on key terms, party names, and important labels.
- Use <ul> or <ol> with <li> for lists and enumerations.
- Use <hr> to separate major sections like the header from the body, or the body from signatures.
- Do NOT put multiple lines in a single <p> with <br> tags. Use separate <p> tags instead.
- Write in Romanian language.
- Use variable placeholders wrapped in double curly braces like {{client.fullName}}.
- ONLY use variables from the list above. Do NOT invent new variable names.
- Make the document professional and legally appropriate for Romanian gas utility companies.`;

const CATEGORY_PROMPTS: Record<string, string> = {
  GDPR: `Generate a GDPR consent and data processing agreement template for a Romanian gas utility company.

Structure the document as follows:
1. <h1> with the document title "ACORD DE CONSIMȚĂMÂNT PENTRU PRELUCRAREA DATELOR CU CARACTER PERSONAL"
2. <p> with document number ({{document.number}}) and date ({{document.date}})
3. <hr>
4. <h2> for each article/section with proper numbering (Articolul 1, Articolul 2, etc.)
5. Party identification paragraphs using variables for company ({{tenant.name}}, {{tenant.cui}}, {{tenant.address}}) and client ({{client.fullName}}, {{client.address}}, {{client.city}}, {{client.county}})
6. Sections covering:
   - Scopul prelucrării datelor (gas installation services)
   - Categorii de date personale colectate (as a <ul> list)
   - Temeiul juridic al prelucrării (GDPR articles)
   - Durata de păstrare a datelor
   - Drepturile persoanei vizate (as a <ul> list: access, rectificare, ștergere, portabilitate, opoziție)
   - Măsuri de securitate
   - Contact pentru protecția datelor
7. <hr> before signature section
8. Signature section with two columns of <p> tags for both parties`,

  SERVICE_AGREEMENT: `Generate a service agreement template for gas installation and maintenance services in Romania.

Structure the document as follows:
1. <h1> with "CONTRACT DE PRESTĂRI SERVICII" and subtitle
2. <p> with contract number ({{document.number}}) and date ({{document.date}})
3. <hr>
4. <h2> for each chapter (Capitolul I, Capitolul II, etc.) with descriptive titles
5. Articles under each chapter using <h3> for "Articolul X" headings
6. Party identification using all relevant variables:
   - Prestator: {{tenant.name}}, CUI: {{tenant.cui}}, Reg. Com.: {{tenant.regCom}}, Sediu: {{tenant.address}}
   - Beneficiar: {{client.fullName}} / {{client.companyName}}, CUI: {{client.cui}}, Adresă: {{client.address}}, {{client.city}}, {{client.county}}
7. Chapters covering:
   - Părțile contractante
   - Obiectul contractului (gas installation, maintenance, inspection at {{project.address}})
   - Durata contractului
   - Prețul și modalitatea de plată
   - Obligațiile prestatorului (as <ol> list)
   - Obligațiile beneficiarului (as <ol> list)
   - Garanție și răspundere
   - Forța majoră
   - Rezilierea contractului
   - Litigii
   - Dispoziții finale
8. <hr> before signature section
9. Signature section with <p> tags for both parties`,
};

export async function generateTemplateContent(
  fastify: FastifyInstance,
  category: string,
  customPrompt?: string
): Promise<string> {
  if (!env.OPENAI_API_KEY) {
    throw fastify.httpErrors.serviceUnavailable(
      "OpenAI API key is not configured"
    );
  }

  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  const categoryPrompt = CATEGORY_PROMPTS[category];
  if (!categoryPrompt && !customPrompt) {
    throw fastify.httpErrors.badRequest(
      `No generation prompt available for category: ${category}`
    );
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: customPrompt || categoryPrompt },
    ],
    temperature: 0.5,
    max_tokens: 8000,
  });

  let content = response.choices[0]?.message?.content;
  if (!content) {
    throw fastify.httpErrors.internalServerError(
      "Failed to generate template content"
    );
  }

  // Strip markdown code fences if present
  content = content.replace(/^```html?\s*\n?/i, "").replace(/\n?```\s*$/i, "");

  // Convert {{variable.id}} placeholders to Tiptap variable node spans
  content = content.replace(
    /\{\{(\w+\.\w+)\}\}/g,
    (_match, id) =>
      `<span data-type="variable" data-id="${id}" data-label="${id}">${id}</span>`
  );

  return content;
}
