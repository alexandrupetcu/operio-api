import OpenAI from "openai";
import { env } from "../../config/env.js";
import type { FastifyInstance } from "fastify";

const SYSTEM_PROMPT = `You are an expert legal document template writer for Romanian gas utility companies.
You generate professional, well-structured HTML document templates in Romanian language.
The templates use variable placeholders in the format {{variableName}} that will be replaced with actual data.

Available variables:
- {{client_company_name}} - Company name
- {{client_cui}} - Company CUI
- {{client_first_name}} - Client first name
- {{client_last_name}} - Client last name
- {{client_name}} - Client full name
- {{client_address}} - Client address
- {{client_city}} - Client city
- {{client_county}} - Client county
- {{client_phone}} - Client phone
- {{client_email}} - Client email
- {{tenant_name}} - Your company name
- {{tenant_cui}} - Your company CUI
- {{tenant_reg_com}} - Your company trade register number
- {{tenant_address}} - Your company address
- {{tenant_phone}} - Your company phone
- {{tenant_email}} - Your company email
- {{tenant_admin_name}} - Your company administrator name
- {{tenant_stamp}} - Your company stamp image (stamp slot 1 / primary)
- {{tenant_stamp_2}}, {{tenant_stamp_3}}, {{tenant_stamp_4}} - Additional stamp images (slots 2-4), for documents needing a different stamp
- {{tenant_signature}} - Your company signature image
- {{project_name}} - Project name
- {{project_address}} - Project address
- {{project_type}} - Project type
- {{services}} - Services table (auto-generated HTML table with selected services + custom services text)
- {{total_price}} - Total contract price
- {{payment_method}} - Payment method description
- {{parent_contract_name}} - Reference contract name (for addendums)
- {{parent_contract_date}} - Reference contract date (for addendums)
- {{addendum_number}} - Addendum number (for addendums)
- {{modifications}} - Modifications description (for addendums)
- {{date}} - Current date
- {{year}} - Current year

CRITICAL FORMATTING RULES:
- Return ONLY raw HTML. Do NOT wrap in markdown code fences (no \`\`\`html).
- Do NOT use <html>, <head>, <body>, <style>, <div>, or <span> tags.
- ONLY use these tags: <h1>, <h2>, <h3>, <p>, <strong>, <em>, <ul>, <ol>, <li>, <br>, <hr>, <table>, <tr>, <td>.
- Use <table> ONLY for the signature section to create a two-column layout (left party and right party). Table borders are invisible in the final document.
- {{tenant_stamp}} and {{tenant_signature}} are image variables — just place them as regular variables inside <p> tags (they will be rendered as images automatically at generation time).
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
- Use variable placeholders wrapped in double curly braces like {{client_name}}.
- ONLY use variables from the list above. Do NOT invent new variable names.
- Variables use underscore notation (e.g. {{tenant_name}}, NOT {{tenant.name}}).
- Make the document professional and legally appropriate for Romanian gas utility companies.`;

const CATEGORY_PROMPTS: Record<string, string> = {
  GDPR: `Generate a GDPR consent and data processing agreement template for a Romanian gas utility company.

Structure the document as follows:
1. <h1> with the document title "ACORD DE CONSIMȚĂMÂNT PENTRU PRELUCRAREA DATELOR CU CARACTER PERSONAL"
2. <p> with document number and date ({{date}})
3. <hr>
4. <h2> for each article/section with proper numbering (Articolul 1, Articolul 2, etc.)
5. Party identification paragraphs using variables for company ({{tenant_name}}, {{tenant_cui}}, {{tenant_address}}) and client ({{client_name}}, {{client_address}}, {{client_city}}, {{client_county}})
6. Sections covering:
   - Scopul prelucrării datelor (gas installation services)
   - Categorii de date personale colectate (as a <ul> list)
   - Temeiul juridic al prelucrării (GDPR articles)
   - Durata de păstrare a datelor
   - Drepturile persoanei vizate (as a <ul> list: access, rectificare, ștergere, portabilitate, opoziție)
   - Măsuri de securitate
   - Contact pentru protecția datelor
7. <hr> before signature section
8. Signature section using a <table> with one <tr> and two <td> cells for two-column layout:
   - Left <td>: <p><strong>Prestator</strong></p>, <p>{{tenant_name}}</p>, <p>Reprezentant: {{tenant_admin_name}}</p>, <p>{{tenant_stamp}}</p>
   - Right <td>: <p><strong>Client</strong></p>, <p>{{client_name}}</p>, <p>Semnătura:</p>`,

  SERVICE_AGREEMENT: `Generate a service agreement template for gas installation and maintenance services in Romania.

Structure the document as follows:
1. <h1> with "CONTRACT DE PRESTĂRI SERVICII" and subtitle
2. <p> with contract number and date ({{date}})
3. <hr>
4. <h2> for each chapter (Capitolul I, Capitolul II, etc.) with descriptive titles
5. Articles under each chapter using <h3> for "Articolul X" headings
6. Party identification using all relevant variables:
   - Prestator: {{tenant_name}}, CUI: {{tenant_cui}}, Reg. Com.: {{tenant_reg_com}}, Sediu: {{tenant_address}}
   - Beneficiar: {{client_name}} / {{client_company_name}}, CUI: {{client_cui}}, Adresă: {{client_address}}, {{client_city}}, {{client_county}}
7. Chapters covering:
   - Părțile contractante
   - Obiectul contractului (gas installation, maintenance, inspection at {{project_address}})
   - Durata contractului
   - Prețul și modalitatea de plată (use {{services}} for the services table, {{total_price}} for total price, {{payment_method}} for payment terms)
   - Obligațiile prestatorului (as <ol> list)
   - Obligațiile beneficiarului (as <ol> list)
   - Garanție și răspundere
   - Forța majoră
   - Rezilierea contractului
   - Litigii
   - Dispoziții finale
8. <hr> before signature section
9. Signature section using a <table> with one <tr> and two <td> cells for two-column layout:
   - Left <td>: <p><strong>Prestator</strong></p>, <p>{{tenant_name}}</p>, <p>Reprezentant: {{tenant_admin_name}}</p>, <p>{{tenant_stamp}}</p>
   - Right <td>: <p><strong>Beneficiar</strong></p>, <p>{{client_name}}</p>, <p>Semnătura:</p>`,

  ACT_ADITIONAL_CONTRACT_SERVICII: `Generate an addendum (act adițional) template for modifying an existing service agreement for a Romanian gas utility company.

Structure the document as follows:
1. <h1> with "ACT ADIȚIONAL Nr. {{addendum_number}}" and subtitle "la {{parent_contract_name}} din {{parent_contract_date}}"
2. <p> with addendum number and date ({{date}})
3. <hr>
4. <h2> for each article (Articolul 1, Articolul 2, etc.)
5. Party identification paragraphs:
   - Prestator: {{tenant_name}}, CUI: {{tenant_cui}}, Reg. Com.: {{tenant_reg_com}}, Sediu: {{tenant_address}}, reprezentat de {{tenant_admin_name}}
   - Beneficiar: {{client_name}} / {{client_company_name}}, CUI: {{client_cui}}, Adresă: {{client_address}}, {{client_city}}, {{client_county}}
6. Opening paragraph: "Părțile au convenit de comun acord modificarea/completarea contractului de prestări servicii prin prezentul act adițional:"
7. Sections covering:
   - Articolul 1 - Obiectul actului adițional: {{modifications}}
   - Articolul 2 - Modificări privind serviciile prestate (use {{services}} for the services list/table if applicable)
   - Articolul 3 - Modificări privind prețul (use {{total_price}} for the new total price)
   - Articolul 4 - Modificări privind modalitatea de plată (use {{payment_method}})
   - Articolul 5 - Termen de aplicare
   - Articolul 6 - Dispoziții finale ("Celelalte clauze ale contractului rămân neschimbate. Prezentul act adițional face parte integrantă din contract.")
8. <hr> before signature section
9. Signature section using a <table> with one <tr> and two <td> cells for two-column layout:
   - Left <td>: <p><strong>Prestator</strong></p>, <p>{{tenant_name}}</p>, <p>Reprezentant: {{tenant_admin_name}}</p>, <p>{{tenant_stamp}}</p>
   - Right <td>: <p><strong>Beneficiar</strong></p>, <p>{{client_name}}</p>, <p>Semnătura:</p>`,
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

  // Convert {{variable}} placeholders to Tiptap variable node spans
  // Handles both underscore (tenant_name) and dot (tenant.name) notation
  content = content.replace(
    /\{\{(\w[\w.]*)\}\}/g,
    (_match, id) =>
      `<span data-type="variable" data-id="${id}" data-label="${id}">{{${id}}}</span>`
  );

  return content;
}
