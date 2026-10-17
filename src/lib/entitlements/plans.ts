import { ALL_FEATURES, type Feature, type Limits } from "./features.js";

/**
 * Catalogul planurilor — pachete de funcții + limite. Se schimbă în git, nu în
 * baza de date; ajustările per firmă stau în `Tenant.entitlementOverrides`.
 * Un modul nou = o cheie nouă în FEATURES și includerea ei aici sau ca add-on.
 */
export type PlanId = "field" | "execution";

export interface PlanDefinition {
  label: string;
  features: Feature[];
  limits: Limits;
}

const match = (patterns: string[]): Feature[] =>
  ALL_FEATURES.filter((f) => patterns.some((p) => (p.endsWith(".*") ? f.startsWith(p.slice(0, -1)) : f === p)));

export const PLANS: Record<PlanId, PlanDefinition> = {
  field: {
    label: "Teren",
    features: match(["field.*"]),
    limits: { technicianSeats: 5 },
  },
  execution: {
    label: "Execuție",
    features: match(["field.*", "projects.*", "documents.dossiers", "integrations.email", "admin.workflow-builder"]),
    limits: { technicianSeats: 10 },
  },
};

export const DEFAULT_PLAN: PlanId = "execution";
export function isPlanId(v: unknown): v is PlanId {
  return v === "field" || v === "execution";
}
