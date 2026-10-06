/**
 * Per-page PDF footer support for the faithful gas-installation documents (RT/PV).
 *
 * The footer travels WITH the rendered HTML as a `<template id="pdf-footer">…</template>`
 * marker, so both the generation worker AND the signing worker (which re-renders the
 * saved HTML) reproduce the same footer without duplicating the build logic.
 */

const FOOTER_MARKER = /<template id="pdf-footer">([\s\S]*?)<\/template>/;

/**
 * Build the footer HTML from the already-computed template data map. Puppeteer
 * renders footerTemplate with font-size 0 and no inherited CSS, so every style
 * is inline here.
 */
export function buildInstalatieFooterHtml(data: Record<string, string>): string {
  const g = (k: string) => (data[k] || "").trim();
  // Client-form footer layout: page number on top, then the bold-italic
  // company/sediu line, the CUI/reg/tel/email line, and the IBAN line.
  const line1 = [
    g("tenant_name"),
    g("tenant_address") ? `Sediu : ${g("tenant_address")}${g("tenant_city") ? ", " + g("tenant_city") : ""}` : "",
  ].filter(Boolean).join(" / ");
  const line2 = [
    g("tenant_cui") ? `CUI : ${g("tenant_cui")}` : "",
    g("tenant_reg_com"),
    g("tenant_phone") ? `Tel : ${g("tenant_phone")}` : "",
    g("tenant_email") ? `E-mail – ${g("tenant_email")}` : "",
  ].filter(Boolean).join(" / ");
  const iban = g("tenant_iban") ? `IBAN: ${g("tenant_iban")}${g("tenant_bank") ? " " + g("tenant_bank") : ""}` : "";
  return (
    `<div style="font-size:7px;width:100%;padding:0 12mm;text-align:center;color:#000;font-family:Arial,sans-serif;line-height:1.4">` +
    `<div style="font-size:8px"><span class="pageNumber"></span></div>` +
    `<div style="font-weight:700;font-style:italic;font-size:7.5px">${line1}</div>` +
    (line2 ? `<div style="font-weight:700;font-style:italic">${line2}</div>` : "") +
    (iban ? `<div>${iban}</div>` : "") +
    `</div>`
  );
}

const HEADER_MARKER = /<template id="pdf-header">([\s\S]*?)<\/template>/;

/** Append the footer marker to rendered HTML (so it persists into the saved S3 copy). */
export function embedFooterMarker(html: string, footerHtml: string): string {
  return `${html}<template id="pdf-footer">${footerHtml}</template>`;
}

/** Append the header marker (puppeteer headerTemplate) to rendered HTML. */
export function embedHeaderMarker(html: string, headerHtml: string): string {
  return `${html}<template id="pdf-header">${headerHtml}</template>`;
}

/**
 * Split a rendered HTML string into its body (markers removed) and the extracted
 * header/footer template HTML (null when absent).
 */
export function extractPdfMarkers(html: string): {
  body: string;
  headerHtml: string | null;
  footerHtml: string | null;
} {
  let body = html;
  const f = body.match(FOOTER_MARKER);
  if (f) body = body.replace(FOOTER_MARKER, "");
  const h = body.match(HEADER_MARKER);
  if (h) body = body.replace(HEADER_MARKER, "");
  return { body, headerHtml: h ? h[1] : null, footerHtml: f ? f[1] : null };
}

/** Back-compat wrapper (footer only). */
export function extractFooterMarker(html: string): { body: string; footerHtml: string | null } {
  const { body, footerHtml } = extractPdfMarkers(html);
  return { body, footerHtml };
}

/**
 * Repeating page header for the service contract: logo (base64 data URL — the
 * puppeteer headerTemplate cannot load network resources) on the left, the firm
 * block centered. All styles inline; explicit font sizes (default is 0).
 */
export function buildContractHeaderHtml(
  data: Record<string, string>,
  logoDataUrl: string | null,
): string {
  const g = (k: string) => (data[k] || "").trim();
  const logo = logoDataUrl
    ? `<img src="${logoDataUrl}" style="height:58px;max-width:150px;object-fit:contain">`
    : "";
  return (
    `<div style="width:100%;padding:4mm 12mm 0;font-family:'Times New Roman',serif;color:#000;display:flex;align-items:center">` +
    `<div style="flex-shrink:0;width:160px;text-align:left">${logo}</div>` +
    `<div style="flex:1;text-align:center;line-height:1.35">` +
    `<div style="font-size:10.5px;font-weight:700">${g("tenant_name")}</div>` +
    `<div style="font-size:8px;font-style:italic">Sediu : ${g("tenant_address")}${g("tenant_city") ? ", " + g("tenant_city") : ""}</div>` +
    `<div style="font-size:8px">CUI : ${g("tenant_cui")}</div>` +
    `<div style="font-size:8px;font-style:italic">${g("tenant_reg_com")}</div>` +
    `<div style="font-size:8px">Tel : <b>${g("tenant_phone")}</b></div>` +
    `<div style="font-size:8px;font-style:italic">E-mail : <b>${g("tenant_email")}</b></div>` +
    `</div>` +
    `<div style="flex-shrink:0;width:160px"></div>` +
    `</div>`
  );
}

/** Repeating contract footer: "pg. N" + Reg. Comerțului + IBAN lines. */
export function buildContractFooterHtml(data: Record<string, string>): string {
  const g = (k: string) => (data[k] || "").trim();
  return (
    `<div style="width:100%;padding:0 12mm;text-align:center;font-family:'Times New Roman',serif;color:#000;line-height:1.4">` +
    `<div style="font-size:8.5px">pg. <span class="pageNumber"></span></div>` +
    `<div style="font-size:8px;font-weight:700">Reg. Comerțului: ${g("tenant_reg_com")}, Cod fiscal: ${g("tenant_cui")}</div>` +
    `<div style="font-size:8px;font-weight:700">IBAN: ${g("tenant_iban")}${g("tenant_bank") ? " " + g("tenant_bank") : ""}</div>` +
    `</div>`
  );
}
