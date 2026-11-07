import { ASSISTANT_MODEL_CHOICES, assistantModelLabel, type AssistantModel } from "../../assistant/models";
import { ConfigSettingBoolean, ConfigSettingEnum, ConfigSettingString, assistantModelSetting } from "../../ui/dashboard-settings";
import { type AsideFrequency } from "./aside-session";

const FREQUENCY_LABELS: Record<AsideFrequency, string> = {
  "on-request": "On request",
  quiet: "Quiet",
  balanced: "Balanced",
  eager: "Eager",
};

export const asideFrequencySetting = new ConfigSettingEnum<AsideFrequency>({
  id: "aside-frequency",
  label: "How often",
  storageKey: "aside.frequency",
  defaultValue: "balanced",
  values: ["on-request", "quiet", "balanced", "eager"],
  formatValue: (value) => FREQUENCY_LABELS[value],
  description:
    "How readily Aside interrupts. Quiet keeps to what you'd get wrong without it; Eager also offers what's merely useful, and makes more model requests. On request never interrupts: it only answers a tap, and uses the model only then.",
});

const CUE_DURATIONS = ["10", "15", "30", "60"] as const;
type CueDuration = (typeof CUE_DURATIONS)[number];

export const asideCueDurationSetting = new ConfigSettingEnum<CueDuration>({
  id: "aside-cue-duration",
  label: "Cue duration",
  storageKey: "aside.cueDuration",
  defaultValue: "15",
  values: CUE_DURATIONS,
  formatValue: (value) => `${value} seconds`,
  description: "How long a cue stays up before it fades into the history. Tapping for detail keeps it up longer.",
});

export function asideCueTtlMs(): number {
  return Number(asideCueDurationSetting.get()) * 1000;
}

export type AsideCaptions = "off" | "last" | "full";

const CAPTION_LABELS: Record<AsideCaptions, string> = { off: "Off", last: "Last lines", full: "Full" };

export const asideCaptionsSetting = new ConfigSettingEnum<AsideCaptions>({
  id: "aside-captions",
  label: "Captions",
  storageKey: "aside.captions",
  defaultValue: "last",
  values: ["off", "last", "full"],
  formatValue: (value) => CAPTION_LABELS[value],
  description: "What Aside shows of the transcript around its cues: a few dim lines, as much as fits, or nothing. Off also updates the display far less often.",
});

export const asideWakeDisplaySetting = new ConfigSettingBoolean({
  id: "aside-wake-display",
  label: "Wake display",
  storageKey: "aside.wakeDisplay",
  defaultValue: true,
  description: "Turn the display on for a cue when it has gone to sleep. When off, those cues wait in the history (scroll up).",
});

export const asideKeepDisplayOnSetting = new ConfigSettingBoolean({
  id: "aside-keep-display-on",
  label: "Keep display on",
  storageKey: "aside.keepDisplayOn",
  defaultValue: false,
  description: "Hold off the screen timeout while Aside is listening in front, for following along with captions.",
});

export const asideAutoSaveSetting = new ConfigSettingBoolean({
  id: "aside-auto-save",
  label: "Save automatically",
  storageKey: "aside.autoSave",
  defaultValue: false,
  description: "Write the recap, cues and transcript to Downloads whenever a recap finishes or the window closes. Otherwise they last only until you close Aside, unless you choose Save.",
});

type AsideModelChoice = "assistant" | Exclude<AssistantModel, "auto" | "hermes">;

const isAsideModel = (value: AssistantModel): value is Exclude<AssistantModel, "auto" | "hermes"> =>
  value !== "auto" && value !== "hermes";

export const asideModelSetting = new ConfigSettingEnum<AsideModelChoice>({
  id: "aside-model",
  label: "Model",
  storageKey: "aside.model",
  defaultValue: "assistant",
  values: ["assistant", ...ASSISTANT_MODEL_CHOICES.filter(isAsideModel)],
  formatValue: (value) => (value === "assistant" ? "Same as assistant" : assistantModelLabel(value)),
  isDisabled: (value) => value !== "assistant" && assistantModelSetting.isDisabled(value),
  description:
    "The model that reads the conversation and writes recaps. It's asked often while people talk, so a faster, cheaper model can suit better than the assistant's. An on-phone model is limited to one check a minute.",
});

export const asideAboutSetting = new ConfigSettingString({
  id: "aside-about",
  label: "About you",
  storageKey: "aside.about",
  defaultValue: "",
  editorTitle: "About you, for Aside",
  description: "Who you are and what you already know, such as your name, job and field, so that Aside doesn't explain what's obvious to you. Sent to the model.",
});

export const asidePrepNotesSetting = new ConfigSettingString({
  id: "aside-prep-notes",
  label: "Prep notes",
  storageKey: "aside.prepNotes",
  defaultValue: "",
  editorTitle: "Prep notes for Aside",
  description: "What the next conversation is about, who's in it, what you want out of it, and facts to have on hand. Stays until you change it. Sent to the model.",
});

/** Whether the wearer has seen what Aside does with the people around them. */
export const asideNoticeSeenSetting = new ConfigSettingBoolean({
  id: "aside-notice-seen",
  label: "Aside notice seen",
  storageKey: "aside.noticeSeen",
  defaultValue: false,
  reportInAnalytics: false,
});

/** Cues marked Not useful, oldest first, as JSON. */
const notUsefulStore = new ConfigSettingString({
  id: "aside-not-useful",
  label: "Not useful cues",
  storageKey: "aside.notUseful",
  defaultValue: "[]",
});

const MAX_NOT_USEFUL = 30;

export function notUsefulCues(): string[] {
  try {
    const parsed: unknown = JSON.parse(notUsefulStore.get());
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function addNotUsefulCue(headline: string): void {
  notUsefulStore.set(JSON.stringify([...notUsefulCues(), headline].slice(-MAX_NOT_USEFUL)));
}

export function clearNotUsefulCues(): void {
  notUsefulStore.set("[]");
}
