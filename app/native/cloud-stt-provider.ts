import type { CloudSttClient, CloudSttOptions } from "./cloud-stt";
import { ElevenLabsSttClient } from "./elevenlabs-stt";
import { OpenAiRealtimeSttClient } from "./openai-stt";
import { ReconnectingSttClient } from "./reconnecting-stt";
import { SonioxSttClient } from "./soniox-stt";
import type { VoiceProviderKind } from "./voice-control";

/**
 * The transcription-provider setting plus the keys the cloud providers need.
 * Shared by the Android and iOS voice bridges.
 */
export type VoiceProviderSelection = {
  provider: VoiceProviderKind;
  elevenLabsApiKey: string;
  openAiApiKey: string;
  sonioxApiKey: string;
};

type CloudProvider = {
  name: string;
  apiKey: (selection: VoiceProviderSelection) => string;
  create: (options: CloudSttOptions) => CloudSttClient;
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
};

/** Whether createCloudSttClient would return a cloud client for this selection. */
export function usesCloudStt(selection: VoiceProviderSelection): boolean {
  return Boolean(CLOUD_PROVIDERS[selection.provider]?.apiKey(selection).trim());
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
): CloudSttClient | null {
  const provider = CLOUD_PROVIDERS[selection.provider];
  if (!provider) return null;
  const apiKey = provider.apiKey(selection).trim();
  if (!apiKey) {
    options.onStatus(`No ${provider.name} key set; using on-device voice.`);
    return null;
  }
  return new ReconnectingSttClient(provider.create, { ...options, apiKey }, continuous);
}
