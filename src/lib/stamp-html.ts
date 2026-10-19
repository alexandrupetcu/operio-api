import { escapeHtml } from "./html-escape.js";

/**
 * Fragmentul HTML al unei ștampile personale (RVT, RSL-IP, instalator) cu
 * semnătura persoanei peste ea, ca la ștampila firmei. Primește URL-uri deja
 * presemnate; le escapează aici. `null` când nu există nici ștampilă, nici semnătură.
 */
export function stampWithSignatureHtml(
  stampUrl: string | null,
  signatureUrl: string | null,
  opts: { alt: string; height?: number },
): string | null {
  const h = opts.height ?? 90;
  const alt = escapeHtml(opts.alt);
  const stamp = stampUrl ? `<img src="${escapeHtml(stampUrl)}" alt="${alt}" style="height:${h}px">` : "";
  const sig = signatureUrl
    ? `<img src="${escapeHtml(signatureUrl)}" alt="Semnătură" style="${
        stampUrl ? "position:absolute;top:80%;left:95%;transform:translate(-50%,-50%);" : ""
      }height:${Math.round(h * 0.75)}px">`
    : "";
  if (!stamp && !sig) return null;
  if (stamp && sig) return `<span style="position:relative;display:inline-block">${stamp}${sig}</span>`;
  return stamp || sig;
}
