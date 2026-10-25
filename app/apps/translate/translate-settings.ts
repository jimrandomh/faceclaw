import { ConfigSettingBoolean, ConfigSettingEnum, voiceProviderSetting, type VoiceProvider } from "../../ui/dashboard-settings";

/**
 * The transcription providers that recognize any spoken language, in picker
 * order. The on-device engines can't: Moonshine and Whisper base.en are
 * English-only, and Apple's recognizer hears only the iPhone's speech language.
 */
const MULTILINGUAL_PROVIDERS = ["elevenlabs", "whisper", "soniox", "whisper-server"] as const satisfies readonly VoiceProvider[];

export type MultilingualProvider = (typeof MULTILINGUAL_PROVIDERS)[number];
export type TranslateProvider = "auto" | MultilingualProvider;

function isMultilingual(provider: VoiceProvider): provider is MultilingualProvider {
  return (MULTILINGUAL_PROVIDERS as readonly VoiceProvider[]).includes(provider);
}

/** Whether the provider has its API key (or, for Whisper server, its URL). */
function isSetUp(provider: MultilingualProvider): boolean {
  return !voiceProviderSetting.isDisabled(provider);
}

/**
 * The provider Translate transcribes with, or null when none is set up. Auto
 * uses the main Transcription Provider when it is multilingual, else the
 * first multilingual provider that is set up.
 */
export function resolveTranslateProvider(choice: TranslateProvider = translateProviderSetting.get()): MultilingualProvider | null {
  if (choice !== "auto") return isSetUp(choice) ? choice : null;
  const main = voiceProviderSetting.get();
  if (isMultilingual(main) && isSetUp(main)) return main;
  return MULTILINGUAL_PROVIDERS.find(isSetUp) ?? null;
}

export const translateProviderSetting = new ConfigSettingEnum<TranslateProvider>({
  id: "translate-provider",
  label: "Transcription provider",
  storageKey: "translate.provider",
  defaultValue: "auto",
  values: ["auto", ...MULTILINGUAL_PROVIDERS],
  formatValue: (value) => {
    if (value !== "auto") return voiceProviderSetting.displayValue(value);
    const resolved = resolveTranslateProvider("auto");
    return `Auto (${resolved ? voiceProviderSetting.displayValue(resolved) : "none set up"})`;
  },
  isDisabled: (value) => value !== "auto" && !isSetUp(value),
  description:
    "Speech-to-text for Translate. Only cloud providers recognize any language (the on-device engines don't), so each needs its API key in Settings > API Keys, or a Whisper server URL in Settings > Voice. Auto uses the main Transcription Provider when it is one of these.",
});

export const translateShowOriginalSetting = new ConfigSettingBoolean({
  id: "translate-show-original",
  label: "Show original",
  storageKey: "translate.showOriginal",
  defaultValue: false,
  description: "Show what was said, dimmed, above each translation.",
});
