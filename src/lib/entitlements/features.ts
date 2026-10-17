/**
 * Funcțiile vandabile ale produsului. Gărzile (API) și interfața verifică DOAR
 * aceste chei — niciodată numele planului — ca planurile să poată fi
 * restructurate fără să atingem codul modulelor. Etichetele sunt pentru
 * administratorul platformei și pagina „Abonament”.
 */
export const FEATURES = {
  "field.mobile": "Aplicația mobilă pentru tehnicieni",
  "field.inspections": "Revizii / verificări instalație, VTP centrale",
  "field.os-registration": "Înregistrare fișe la OS, Anexa 6",
  "projects.workflows": "Proiecte cu workflow pe distribuitor",
  "projects.permits": "Avize în paralel + extragere din Certificatul de Urbanism (AI)",
  "projects.drawings": "Schițe tehnice",
  "documents.dossiers": "Carte Branșament / Carte Conductă / Dosar ISCIR",
  "integrations.email": "Ingestie e-mail (Gmail)",
  "admin.workflow-builder": "Builder vizual de workflow",
} as const;

export type Feature = keyof typeof FEATURES;
export const ALL_FEATURES = Object.keys(FEATURES) as Feature[];

export function isFeature(v: unknown): v is Feature {
  return typeof v === "string" && v in FEATURES;
}

/** Limite numerice (0 = nelimitat nu există — folosim Infinity explicit). */
export interface Limits {
  technicianSeats: number;
}
