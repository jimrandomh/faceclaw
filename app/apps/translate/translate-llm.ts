/**
 * Streamed translation against the assistant's configured model (Settings >
 * Assistant). Each call translates one stretch of speech into English; see
 * TranslationModel for how stretches are batched and given context.
 */
import { streamAnthropicMessage } from "../../native/anthropic";
import { streamLocalQwen } from "../../native/llama";
import { streamOpenAiResponse } from "../../native/openai";
import { resolveAssistantModel, type ResolvedAssistantModel } from "../../assistant/models";
import { type LlmStreamHandle, type LlmStreamOptions } from "../../assistant/llm-protocol";
import { anthropicApiKeySetting, assistantModelSetting, openAiApiKeySetting } from "../../ui/dashboard-settings";
import { TRANSLATE_SYSTEM_PROMPT, buildTranslateUserMessage } from "../../prompts";
import { type TranslationTurn } from "./translation-model";

/**
 * The model Translate uses, or null when none is configured. Hermes is an
 * agent with its own tools and memory rather than a translator (every
 * utterance would land in its session), so it falls back to Auto: the model
 * for whichever API key is set, else the on-phone model.
 */
export function resolveTranslationModel(): ResolvedAssistantModel | null {
  const selection = assistantModelSetting.get();
  return resolveAssistantModel(selection === "hermes" ? "auto" : selection, {
    anthropic: anthropicApiKeySetting.get(),
    openai: openAiApiKeySetting.get(),
  });
}

export type TranslationRequest = {
  speech: string;
  context: TranslationTurn[];
  onProgress: (textSoFar: string) => void;
  onDone: (translation: string) => void;
  onError: (message: string) => void;
};

export function streamTranslation(model: ResolvedAssistantModel, request: TranslationRequest): LlmStreamHandle {
  const options: LlmStreamOptions = {
    apiKey: model.apiKey,
    model: model.model,
    system: TRANSLATE_SYSTEM_PROMPT,
    effort: model.effort,
    maxTokens: 1024,
    messages: [{ role: "user", content: buildTranslateUserMessage(request.speech, request.context) }],
    onTextDelta: (_delta, textSoFar) => request.onProgress(cleanTranslation(textSoFar)),
    onDone: (result) => {
      if (result.stopReason === "refusal") request.onError("The model declined to translate this.");
      else request.onDone(cleanTranslation(result.text));
    },
    onError: request.onError,
  };
  switch (model.provider) {
    case "openai":
      return streamOpenAiResponse(options);
    case "local":
      return streamLocalQwen(options);
    default:
      return streamAnthropicMessage(options);
  }
}

/** The context turns are tagged <english>; a model may echo the tag around its reply. */
function cleanTranslation(text: string): string {
  return text.replace(/^\s*<english>/i, "").replace(/<\/english>\s*$/i, "").trim();
}
