/**
 * Modelele OpenAI folosite de aplicație, configurabile din mediu fără deploy:
 *   - `OPENAI_MODEL_VISION` — extragerea din documente scanate / fotografiate (factura de
 *     gaze, autorizația ANRE, avize), unde contează calitatea pe poze proaste;
 *   - `OPENAI_MODEL_TEXT`   — extragerea din text (raport de analizor necunoscut) și
 *     generarea de șabloane.
 *
 * Familia GPT-5 e „cu raționament”: nu acceptă `temperature`, iar la chat completions
 * plafonul e `max_completion_tokens`. Pentru extragere ținem efortul mic (răspuns rapid,
 * tehnicianul așteaptă în wizard). Helperele de mai jos aleg parametrii potriviți
 * modelului, ca o schimbare din `.env` (ex. înapoi la gpt-4.1) să nu ceară cod.
 */
/** GPT-5.x / o-series (fără variantele „-chat”, care sunt modele clasice). */
export function isReasoningModel(model: string): boolean {
  if (/-chat/.test(model)) return false;
  return /^(gpt-5|o[1-9])/.test(model);
}

type Effort = "low" | "medium" | "high";

/** Parametrii pentru `openai.responses.create` (documente / vision). */
export function responsesParams(model: string, opts: { temperature: number; maxOutputTokens: number; effort?: Effort }) {
  return {
    model,
    // Nu păstrăm documentele clienților pe partea OpenAI.
    store: false as const,
    max_output_tokens: opts.maxOutputTokens,
    ...(isReasoningModel(model) ? { reasoning: { effort: opts.effort ?? "low" } } : { temperature: opts.temperature }),
  };
}

/** Parametrii pentru `openai.chat.completions.create` (text). */
export function chatParams(model: string, opts: { temperature: number; maxTokens: number; effort?: Effort }) {
  return {
    model,
    store: false as const,
    ...(isReasoningModel(model)
      ? { max_completion_tokens: opts.maxTokens, reasoning_effort: opts.effort ?? "low" }
      : { max_tokens: opts.maxTokens, temperature: opts.temperature }),
  };
}
