import type { CloudSttClient, CloudSttOptions } from "./cloud-stt";
import { ElevenLabsSttClient } from "./elevenlabs-stt";
import { OpenAiRealtimeSttClient } from "./openai-stt";
import { ReconnectingSttClient } from "./reconnecting-stt";
import { SonioxSttClient } from "./soniox-stt";
import type { VoiceProviderKind } from "./voice-control";
import { normalizeWhisperServerUrl, WHISPER_SERVER_FINAL_TIMEOUT_MS, WhisperServerSttClient } from "./whisper-server-stt";

/**
 * The transcription-provider setting plus the keys the cloud providers need.
 * Shared by the Android and iOS voice bridges.
 */
export type VoiceProviderSelection = {
  provider: VoiceProviderKind;
  /**
   * Spoken language the provider should expect (ISO 639-1); empty lets it
   * detect the language. Cloud providers only.
   */
  language?: string;
  elevenLabsApiKey: string;
  openAiApiKey: string;
  sonioxApiKey: string;
  /** Self-hosted Whisper ("whisper-server"); the key is optional there. */
  whisperServerUrl?: string;
  whisperServerModel?: string;
  whisperServerApiKey?: string;
};

type CloudProvider = {
  name: string;
  apiKey: (selection: VoiceProviderSelection) => string;
  /** Whether the provider can run; defaults to having a key. */
  configured?: (selection: VoiceProviderSelection) => boolean;
  /** What to tell the user when it can't. */
  missing?: string;
  create: (options: CloudSttOptions, selection: VoiceProviderSelection) => CloudSttClient;
  finalTimeoutMs?: number;
};

// Providers absent here ("onboard", "onboard-whisper") transcribe on-device.
const CLOUD_PROVIDERS: Partial<Record<VoiceProviderKind, CloudProvider>> = {
  elevenlabs: {
    name: "ElevenLabs",
    apiKey: (selection) => selection.elevenLabsApiKey,
    create: (options) => new ElevenLabsSttClient(options),
  },
  soniox: {
    name: "Soniox",
    apiKey: (selection) => selection.sonioxApiKey,
    create: (options) => new SonioxSttClient(options),
  },
  whisper: {
    name: "OpenAI",
    apiKey: (selection) => selection.openAiApiKey,
    create: (options) => new OpenAiRealtimeSttClient(options),
  },
  "whisper-server": {
    name: "Whisper server",
    apiKey: (selection) => selection.whisperServerApiKey ?? "",
    configured: (selection) => Boolean(normalizeWhisperServerUrl(selection.whisperServerUrl ?? "")),
    missing: "No Whisper server URL set; using on-device voice.",
    create: (options, selection) => new WhisperServerSttClient(options, {
      baseUrl: selection.whisperServerUrl ?? "",
      model: selection.whisperServerModel ?? "",
      language: selection.language ?? "",
    }),
    finalTimeoutMs: WHISPER_SERVER_FINAL_TIMEOUT_MS,
  },
};

function isConfigured(provider: CloudProvider, selection: VoiceProviderSelection): boolean {
  return provider.configured ? provider.configured(selection) : Boolean(provider.apiKey(selection).trim());
}

/**
 * What a capture transcribes with: the provider and the language it is told
 * to expect. A running capture is shared only by holders asking for the same.
 */
export function transcriptionKey(selection: Pick<VoiceProviderSelection, "provider" | "language">): string {
  return `${selection.provider}:${(selection.language ?? "").trim().toLowerCase()}`;
}

/** Whether createCloudSttClient would return a cloud client for this selection. */
export function usesCloudStt(selection: VoiceProviderSelection): boolean {
  const provider = CLOUD_PROVIDERS[selection.provider];
  return Boolean(provider && isConfigured(provider, selection));
}

/**
 * The cloud provider for a capture, or null to transcribe on-device. A cloud
 * provider whose API key is missing falls back to on-device (reported via
 * onStatus) rather than failing the capture outright. `continuous` says
 * whether the capture is open-ended (Transcribe), where pauses commit segments.
 */
export function createCloudSttClient(
  selection: VoiceProviderSelection,
  options: Omit<CloudSttOptions, "apiKey">,
  continuous: () => boolean,
): ReconnectingSttClient | null {
  const provider = CLOUD_PROVIDERS[selection.provider];
  if (!provider) return null;
  if (!isConfigured(provider, selection)) {
    options.onStatus(provider.missing ?? `No ${provider.name} key set; using on-device voice.`);
    return null;
  }
  const apiKey = provider.apiKey(selection).trim();
  return new ReconnectingSttClient(
    (clientOptions) => provider.create(clientOptions, selection),
    { ...options, apiKey, language: (selection.language ?? "").trim() },
    continuous,
    provider.finalTimeoutMs,
  );
}
