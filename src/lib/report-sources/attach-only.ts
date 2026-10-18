import { emptyParsedRevision, type ReportSource } from "./types.js";

export const ATTACH_ONLY_SOURCE_ID = "attach-only";

/**
 * Fără extragere: PDF-ul se atașează ca fișier, citirile rămân goale. E
 * rezerva registrului (nicio sursă nu recunoaște textul) și strategia „attach"
 * din setările firmei.
 */
export const attachOnlySource: ReportSource = {
  id: ATTACH_ONLY_SOURCE_ID,
  label: "Doar atașare (fără extragere)",
  kind: "attach",
  fields: [],
  detect() {
    return 0;
  },
  async parse({ text }) {
    return emptyParsedRevision(text ?? "");
  },
};
