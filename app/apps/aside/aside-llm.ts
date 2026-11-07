/**
 * Aside's requests to the model: a cue check, and the end-of-conversation
 * recap. Prompt text lives in app/prompts.ts.
 */
import { resolveFeatureModel, streamFeatureModel } from "../../assistant/feature-model";
import { type LlmStreamHandle } from "../../assistant/llm-protocol";
import { type ResolvedAssistantModel } from "../../assistant/models";
import {
  ASIDE_CUE_SYSTEM_PROMPT,
  ASIDE_RECAP_SYSTEM_PROMPT,
  buildAsideCueUserMessage,
  buildAsideRecapUserMessage,
  type AsideCueBar,
} from "../../prompts";
import { trimContext, type ContextLimits, type CueCheck } from "./aside-session";
import { asideAboutSetting, asideModelSetting, asidePrepNotesSetting, notUsefulCues } from "./aside-settings";

// About 13 minutes of speech for the cloud. The on-phone models have a
// 4096-token context, shared with the prompt and reply.
const CLOUD_CUE_CONTEXT: ContextLimits = { headChars: 1_500, tailChars: 6_500 };
const LOCAL_CUE_CONTEXT: ContextLimits = { headChars: 400, tailChars: 2_600 };
const CLOUD_RECAP_CONTEXT: ContextLimits = { headChars: 30_000, tailChars: 30_000 };
const LOCAL_RECAP_CONTEXT: ContextLimits = { headChars: 1_000, tailChars: 7_000 };

// Generous for what a cue needs, because reasoning models count their thinking
// here too and would otherwise end with nothing written. NONE costs a few tokens.
const CUE_MAX_TOKENS = 800;
const RECAP_MAX_TOKENS = 2_000;

/** The model Aside uses, or null when none is configured. */
export function resolveAsideModel(): ResolvedAssistantModel | null {
  const choice = asideModelSetting.get();
  return choice === "assistant" ? resolveFeatureModel() : resolveFeatureModel(choice);
}

export function cueContextLimits(model: ResolvedAssistantModel): ContextLimits {
  return model.provider === "local" ? LOCAL_CUE_CONTEXT : CLOUD_CUE_CONTEXT;
}

export function streamCueCheck(
  model: ResolvedAssistantModel,
  check: CueCheck,
  bar: AsideCueBar | null,
  callbacks: { onDone: (reply: string) => void; onError: (message: string) => void },
): LlmStreamHandle {
  return streamFeatureModel(model, {
    system: ASIDE_CUE_SYSTEM_PROMPT,
    maxTokens: CUE_MAX_TOKENS,
    messages: [{
      role: "user",
      content: buildAsideCueUserMessage({
        about: asideAboutSetting.get(),
        prepNotes: asidePrepNotesSetting.get(),
        notUseful: notUsefulCues(),
        shownCues: check.shownCues,
        earlier: check.earlier,
        justSaid: check.justSaid,
        bar,
        question: check.question,
      }),
    }],
    // A refusal is just one more thing not worth interrupting for.
    onDone: (result) => callbacks.onDone(result.stopReason === "refusal" ? "" : result.text),
    onError: callbacks.onError,
  });
}

export function streamRecap(
  model: ResolvedAssistantModel,
  transcript: string,
  callbacks: { onProgress: (textSoFar: string) => void; onDone: (text: string) => void; onError: (message: string) => void },
): LlmStreamHandle {
  const limits = model.provider === "local" ? LOCAL_RECAP_CONTEXT : CLOUD_RECAP_CONTEXT;
  return streamFeatureModel(model, {
    system: ASIDE_RECAP_SYSTEM_PROMPT,
    maxTokens: RECAP_MAX_TOKENS,
    messages: [{
      role: "user",
      content: buildAsideRecapUserMessage({
        about: asideAboutSetting.get(),
        prepNotes: asidePrepNotesSetting.get(),
        transcript: trimContext(transcript, limits),
      }),
    }],
    onTextDelta: (_delta, textSoFar) => callbacks.onProgress(textSoFar),
    onDone: (result) => {
      if (result.stopReason === "refusal") callbacks.onError("The model declined to write a recap.");
      else callbacks.onDone(result.text);
    },
    onError: callbacks.onError,
  });
}
