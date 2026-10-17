/**
 * Minimal HTML escaper for text that is interpolated into template HTML
 * (rendered by puppeteer). Covers text nodes AND double-quoted attributes.
 * `null`/`undefined` become "" so a missing value renders like today.
 */
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: unknown): string {
  if (value == null) return "";
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
