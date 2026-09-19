import { isLocalModelReady, LOCAL_MODEL } from "../native/llama";

export const ASSISTANT_MODEL_VALUES = [
  "auto",
  "hauku",
  "sonnet",
  "opus",
  "fable",
  "luna",
  "terra",
  "sol",
  "qwen",
] as const;

export type AssistantModel = (typeof ASSISTANT_MODEL_VALUES)[number];
/** Keep saved model IDs portable, while offering only supported choices. */
export const ASSISTANT_MODEL_CHOICES: readonly AssistantModel[] =
  global.isIOS ? ASSISTANT_MODEL_VALUES.filter(value => value !== "qwen") : ASSISTANT_MODEL_VALUES;
export function supportedAssistantModel(value: AssistantModel): AssistantModel {
  return global.isIOS && value === "qwen" ? "auto" : value;
}

export type AssistantProvider = "anthropic" | "openai" | "local";

export type AssistantApiKeys = {
  anthropic: string;
  openai: string;
};

export type ResolvedAssistantModel = {
  selection: AssistantModel;
  provider: AssistantProvider;
  model: string;
  apiKey: string;
  effort?: "low" | "medium" | "high";
};

type ModelDefinition = {
  label: string;
  provider: AssistantProvider;
  model: string;
  effort?: "low" | "medium" | "high";
};

const MODEL_DEFINITIONS: Record<Exclude<AssistantModel, "auto">, ModelDefinition> = {
  // Keep the user-facing spelling requested for the picker while using
  // Anthropic's canonical Haiku alias on the wire.
  hauku: { label: "Haiku", provider: "anthropic", model: "claude-haiku-4-5" },
  sonnet: { label: "Sonnet", provider: "anthropic", model: "claude-sonnet-5", effort: "low" },
  opus: { label: "Opus", provider: "anthropic", model: "claude-opus-5", effort: "low" },
  fable: { label: "Fable", provider: "anthropic", model: "claude-fable-5", effort: "low" },
  luna: { label: "Luna", provider: "openai", model: "gpt-5.6-luna", effort: "low" },
  terra: { label: "Terra", provider: "openai", model: "gpt-5.6-terra", effort: "low" },
  sol: { label: "Sol", provider: "openai", model: "gpt-5.6-sol", effort: "low" },
  // Runs on the phone itself (llama.cpp); needs the downloaded model file,
  // not an API key. The default for users who haven't set any key.
  qwen: { label: `${LOCAL_MODEL.label} (on-phone)`, provider: "local", model: LOCAL_MODEL.id },
};

export function assistantModelLabel(value: AssistantModel): string {
  return value === "auto" ? "Auto" : MODEL_DEFINITIONS[value].label;
}

export function assistantModelProvider(value: AssistantModel): AssistantProvider | null {
  return value === "auto" ? null : MODEL_DEFINITIONS[value].provider;
}

/**
 * Resolve Auto and attach the credential needed by the chosen provider.
 * Auto intentionally prefers Terra over Sonnet when both keys are available,
 * and falls back to the on-phone model when no key is set but the model file
 * has been downloaded.
 */
export function resolveAssistantModel(
  selection: AssistantModel,
  keys: AssistantApiKeys,
): ResolvedAssistantModel | null {
  const normalizedKeys: AssistantApiKeys = {
    anthropic: keys.anthropic.trim(),
    openai: keys.openai.trim(),
  };
  let resolvedSelection = selection;
  if (selection === "auto") {
    if (normalizedKeys.openai) {
      resolvedSelection = "terra";
    } else if (normalizedKeys.anthropic) {
      resolvedSelection = "sonnet";
    } else if (isLocalModelReady()) {
      resolvedSelection = "qwen";
    } else {
      return null;
    }
  }

  const definition = MODEL_DEFINITIONS[resolvedSelection as Exclude<AssistantModel, "auto">];
  if (definition.provider === "local") {
    if (!isLocalModelReady()) return null;
    return {
      selection,
      provider: definition.provider,
      model: definition.model,
      apiKey: "",
      effort: definition.effort,
    };
  }
  const apiKey = normalizedKeys[definition.provider];
  if (!apiKey) return null;
  return {
    selection,
    provider: definition.provider,
    model: definition.model,
    apiKey,
    effort: definition.effort,
  };
}
