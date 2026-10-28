import { sanitizeTemplateInput } from "./template-input.js";
import { withAliases } from "./dossier-fields.js";

/**
 * Datele completate în pașii workflow-ului unui proiect, pentru generarea documentelor.
 *
 * Workflow-ul principal al proiectului rămâne „active” până la final — pasul de
 * generare rulează chiar în timpul lui —, deci trebuie citit și în starea asta.
 */
export const STEP_OUTPUT_INSTANCE_STATUSES = ["active", "running", "completed"];

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** „2026-07-22” (câmpurile de dată din formularele workflow-ului) → „22.07.2026”, ca în dosare. */
function roDate(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const m = v.trim().match(ISO_DATE);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : v;
}

const empty = (v: unknown) => v === undefined || v === null || v === "";

/**
 * Pune ieșirile pașilor (în ordinea finalizării) peste metadatele proiectului, ÎNAINTE
 * de derivări (lungimi, etape, date PV): o valoare din pas completează un câmp gol al
 * proiectului; ce e completat pe proiect (editorul de dosar) are prioritate. Pașii de
 * mai târziu bat pe cei anteriori. `prefixed` = aceleași valori ca `<cod_pas>.<cheie>`.
 */
export function mergeStepOutputs(
  meta: Record<string, unknown>,
  steps: { code: string | null | undefined; output: unknown }[],
): { meta: Record<string, unknown>; prefixed: Record<string, unknown> } {
  const fromSteps: Record<string, unknown> = {};
  const prefixed: Record<string, unknown> = {};
  for (const step of steps) {
    // Ieșirile pașilor sunt JSON trimis de utilizator → aceeași curățare ca metadatele.
    const output = sanitizeTemplateInput(step.output);
    for (const [key, raw] of Object.entries(output)) {
      const value = roDate(raw);
      if (step.code) prefixed[`${step.code}.${key}`] = value;
      if (!empty(value)) fromSteps[key] = value;
    }
  }
  const merged: Record<string, unknown> = { ...meta };
  for (const [key, value] of Object.entries(withAliases(fromSteps))) {
    if (empty(merged[key])) merged[key] = value;
  }
  return { meta: withAliases(merged), prefixed };
}
