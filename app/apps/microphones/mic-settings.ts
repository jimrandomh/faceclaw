import { ConfigSettingBoolean, ConfigSettingEnum } from "../../ui/dashboard-settings";

/**
 * Microphones app settings. All stored through the shared settings store so
 * the phone UI, glasses menus, and the session engine see the same values.
 */

export type RetentionPeriod = "none" | "1d" | "1w" | "1m" | "1q" | "1y" | "forever";

const RETENTION_VALUES: readonly RetentionPeriod[] = ["none", "1d", "1w", "1m", "1q", "1y", "forever"];

const RETENTION_LABELS: Record<RetentionPeriod, string> = {
  none: "None",
  "1d": "1 day",
  "1w": "1 week",
  "1m": "1 month",
  "1q": "1 quarter",
  "1y": "1 year",
  forever: "Forever",
};

export function retentionLabel(period: RetentionPeriod): string {
  return RETENTION_LABELS[period];
}

/**
 * The deletion cutoff timestamp for a retention period as of now, or 0 when
 * nothing should be deleted. "None" deletes everything already stored (and
 * the session engine also skips persisting new data).
 */
export function retentionCutoffMs(period: RetentionPeriod, nowMs: number): number {
  const day = 24 * 60 * 60 * 1000;
  switch (period) {
    case "none":
      return nowMs;
    case "1d":
      return nowMs - day;
    case "1w":
      return nowMs - 7 * day;
    case "1m":
      return nowMs - 30 * day;
    case "1q":
      return nowMs - 91 * day;
    case "1y":
      return nowMs - 365 * day;
    case "forever":
      return 0;
  }
}

export const captionsEnabledSetting = new ConfigSettingBoolean({
  id: "microphones-captions",
  label: "Captions",
  description: "Live speech-to-text captions with speaker names, from the glasses microphones.",
  storageKey: "microphones.captions-enabled",
  defaultValue: false,
});

export const translateEnabledSetting = new ConfigSettingBoolean({
  id: "microphones-translate",
  label: "Translate",
  description:
    "Detect foreign languages in captions and show a translation to the phone's language beneath the original line.",
  storageKey: "microphones.translate-enabled",
  defaultValue: false,
});

export const saveCaptionsSetting = new ConfigSettingBoolean({
  id: "microphones-save-captions",
  label: "Save captions",
  description: "Keep caption transcripts for later review in the phone app.",
  storageKey: "microphones.save-captions",
  defaultValue: true,
});

export const saveRecordingsSetting = new ConfigSettingBoolean({
  id: "microphones-save-recordings",
  label: "Save recordings",
  description:
    "Keep the audio of caption sessions (compressed to AAC) so transcripts can be replayed and re-analyzed.",
  storageKey: "microphones.save-recordings",
  defaultValue: false,
});

export const captionsRetentionSetting = new ConfigSettingEnum<RetentionPeriod>({
  id: "microphones-captions-retention",
  label: "Keep captions",
  description: "How long saved captions are retained before automatic deletion.",
  storageKey: "microphones.captions-retention",
  defaultValue: "1m",
  values: RETENTION_VALUES,
  formatValue: retentionLabel,
});

export const recordingsRetentionSetting = new ConfigSettingEnum<RetentionPeriod>({
  id: "microphones-recordings-retention",
  label: "Keep recordings",
  description: "How long saved recordings are retained before automatic deletion.",
  storageKey: "microphones.recordings-retention",
  defaultValue: "1w",
  values: RETENTION_VALUES,
  formatValue: retentionLabel,
});

export const beamFilterSetting = new ConfigSettingBoolean({
  id: "microphones-beam-filter",
  label: "Beam filter",
  description:
    "Only listen to sounds from the shaded direction on the Sonic Radar; audio from other directions is muted.",
  storageKey: "microphones.beam-filter",
  defaultValue: false,
});

export const ancEnabledSetting = new ConfigSettingBoolean({
  id: "microphones-anc",
  label: "Noise cancellation",
  description:
    "Cancel background noise in captured audio: spectral noise suppression on the phone, plus adaptive inter-mic cancellation when the 4-mic array is streaming.",
  storageKey: "microphones.anc-enabled",
  defaultValue: true,
});

export const wearerCommandsOnlySetting = new ConfigSettingBoolean({
  id: "microphones-wearer-commands",
  label: "My voice only",
  description:
    "Restrict voice command recognition to your own enrolled voice; other speakers are captioned but cannot trigger commands.",
  storageKey: "microphones.wearer-commands-only",
  defaultValue: false,
});
