import { describe, expect, it } from "vitest";
import { chatParams, isReasoningModel, responsesParams } from "./openai-models.js";

describe("modelele OpenAI — parametrii după familie", () => {
  it("GPT-5.x și o-series sunt cu raționament; variantele -chat și gpt-4.1 nu", () => {
    expect(isReasoningModel("gpt-5.4")).toBe(true);
    expect(isReasoningModel("gpt-5.4-mini")).toBe(true);
    expect(isReasoningModel("o4-mini")).toBe(true);
    expect(isReasoningModel("gpt-5.2-chat-latest")).toBe(false);
    expect(isReasoningModel("gpt-4.1")).toBe(false);
  });

  it("responses: GPT-5 primește efort mic și fără temperature; gpt-4.1 primește temperature", () => {
    expect(responsesParams("gpt-5.4", { temperature: 0.1, maxOutputTokens: 2000 })).toEqual({
      model: "gpt-5.4",
      store: false,
      max_output_tokens: 2000,
      reasoning: { effort: "low" },
    });
    expect(responsesParams("gpt-4.1", { temperature: 0.1, maxOutputTokens: 2000 })).toEqual({
      model: "gpt-4.1",
      store: false,
      max_output_tokens: 2000,
      temperature: 0.1,
    });
  });

  it("chat completions: GPT-5 folosește max_completion_tokens + reasoning_effort; gpt-4.1 max_tokens + temperature", () => {
    expect(chatParams("gpt-5.4-mini", { temperature: 0, maxTokens: 2000 })).toEqual({
      model: "gpt-5.4-mini",
      store: false,
      max_completion_tokens: 2000,
      reasoning_effort: "low",
    });
    expect(chatParams("gpt-4.1-mini", { temperature: 0.5, maxTokens: 8000, effort: "medium" })).toEqual({
      model: "gpt-4.1-mini",
      store: false,
      max_tokens: 8000,
      temperature: 0.5,
    });
  });
});
