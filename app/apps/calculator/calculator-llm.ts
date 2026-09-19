/**
 * One-shot completion against the assistant's configured model, used by the
 * Calculator's optional rewrite fallback (see MathCoordinator.answerSpoken:
 * the deterministic parser runs first; the model only ever translates words
 * into notation). Resolves to null when no provider is configured or the
 * call fails — the calculator then reports "could not read that" instead of
 * surfacing a transport error.
 */
import { streamAnthropicMessage } from "../../native/anthropic";
import { streamLocalQwen } from "../../native/llama";
import { streamOpenAiResponse } from "../../native/openai";
import { resolveAssistantModel } from "../../assistant/models";
import { type LlmStreamOptions } from "../../assistant/llm-protocol";
import {
  anthropicApiKeySetting,
  assistantModelSetting,
  openAiApiKeySetting,
} from "../../ui/dashboard-settings";
import { CALCULATOR_REWRITE_SYSTEM_PROMPT, buildCalculatorRewriteUserMessage } from "../../prompts";

export function rewriteSpokenProblem(spoken: string): Promise<string | null> {
  const resolved = resolveAssistantModel(assistantModelSetting.get(), {
    anthropic: anthropicApiKeySetting.get(),
    openai: openAiApiKeySetting.get(),
  });
  if (!resolved) return Promise.resolve(null);

  return new Promise((resolve) => {
    const options: LlmStreamOptions = {
      apiKey: resolved.apiKey,
      model: resolved.model,
      system: CALCULATOR_REWRITE_SYSTEM_PROMPT,
      effort: "low",
      maxTokens: 200,
      messages: [{ role: "user", content: buildCalculatorRewriteUserMessage(spoken) }],
      onDone: (result) => resolve(result.text ?? null),
      onError: () => resolve(null),
    };
    switch (resolved.provider) {
      case "openai":
        streamOpenAiResponse(options);
        break;
      case "local":
        streamLocalQwen(options);
        break;
      default:
        streamAnthropicMessage(options);
        break;
    }
  });
}
