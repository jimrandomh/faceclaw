/**
 * Streamed translation against the assistant's configured model (Settings >
 * Assistant). Each call translates one stretch of speech into English; see
 * TranslationModel for how stretches are batched and given context.
 */
import { resolveFeatureModel, streamFeatureModel } from "../../assistant/feature-model";
import { type ResolvedAssistantModel } from "../../assistant/models";
import { type LlmStreamHandle } from "../../assistant/llm-protocol";
import { TRANSLATE_SYSTEM_PROMPT, buildTranslateUserMessage } from "../../prompts";
import { type TranslationTurn } from "./translation-model";

/** The model Translate uses, or null when none is configured. */
export function resolveTranslationModel(): ResolvedAssistantModel | null {
  return resolveFeatureModel();
}

export type TranslationRequest = {
  speech: string;
  context: TranslationTurn[];
  /** English name of the spoken language when the user set one, else "". */
  language: string;
  onProgress: (textSoFar: string) => void;
  onDone: (translation: string) => void;
  onError: (message: string) => void;
};

export function streamTranslation(model: ResolvedAssistantModel, request: TranslationRequest): LlmStreamHandle {
  return streamFeatureModel(model, {
    system: TRANSLATE_SYSTEM_PROMPT,
    maxTokens: 1024,
    messages: [{ role: "user", content: buildTranslateUserMessage(request.speech, request.context, request.language) }],
    onTextDelta: (_delta, textSoFar) => request.onProgress(cleanTranslation(textSoFar)),
    onDone: (result) => {
      if (result.stopReason === "refusal") request.onError("The model declined to translate this.");
      else request.onDone(cleanTranslation(result.text));
    },
    onError: request.onError,
  });
}

/** The context turns are tagged <english>; a model may echo the tag around its reply. */
function cleanTranslation(text: string): string {
  return text.replace(/^\s*<english>/i, "").replace(/<\/english>\s*$/i, "").trim();
}
