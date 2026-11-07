/**
 * The assistant's configured model, for apps that call it directly instead of
 * through the voice assistant's loop (Translate, Aside).
 */
import { streamAnthropicMessage } from "../native/anthropic";
import { streamLocalModel } from "../native/local-llm";
import { streamOpenAiResponse } from "../native/openai";
import { streamOpenAiCompatibleChat } from "../native/openai-chat";
import {
  anthropicApiKeySetting, assistantModelSetting, assistantOpenAiCompatibleKeySetting,
  assistantOpenAiCompatibleModelSetting, assistantOpenAiCompatibleUrlSetting, openAiApiKeySetting,
} from "../ui/dashboard-settings";
import { type LlmStreamHandle, type LlmStreamOptions } from "./llm-protocol";
import { resolveAssistantModel, type AssistantModel, type ResolvedAssistantModel } from "./models";

/**
 * The model to use, or null when none is configured. Hermes is an agent with
 * its own tools and memory rather than a plain model (every request would land
 * in its session), so it falls back to Auto: the model for whichever API key
 * is set, else the on-phone model.
 */
export function resolveFeatureModel(selection: AssistantModel = assistantModelSetting.get()): ResolvedAssistantModel | null {
  return resolveAssistantModel(selection === "hermes" ? "auto" : selection, {
    anthropic: anthropicApiKeySetting.get(),
    openai: openAiApiKeySetting.get(),
    openAiCompatibleUrl: assistantOpenAiCompatibleUrlSetting.get(),
    openAiCompatibleKey: assistantOpenAiCompatibleKeySetting.get(),
    openAiCompatibleModel: assistantOpenAiCompatibleModelSetting.get(),
  });
}

/** Stream one request with a resolved model; its credentials and effort fill in the rest. */
export function streamFeatureModel(
  model: ResolvedAssistantModel,
  request: Omit<LlmStreamOptions, "apiKey" | "model" | "effort">,
): LlmStreamHandle {
  const options: LlmStreamOptions = { ...request, apiKey: model.apiKey, model: model.model, effort: model.effort };
  switch (model.provider) {
    case "openai":
      return streamOpenAiResponse(options);
    case "openai-compatible":
      return streamOpenAiCompatibleChat({ ...options, baseUrl: model.baseUrl ?? "" });
    case "local":
      return streamLocalModel(options);
    default:
      return streamAnthropicMessage(options);
  }
}
