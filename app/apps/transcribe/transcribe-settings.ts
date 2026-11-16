import { ConfigSettingEnum, glassesTypeSetting } from "../../ui/dashboard-settings";
import { type MicCount } from "../../ui/layers";
import { micControlSupported } from "../microphones/mic-control";

export type TranscribeMics = "1" | "2" | "4";

const MICS_LABELS: Record<TranscribeMics, string> = {
  "1": "1 (mixed)",
  "2": "2 (one per temple)",
  "4": "4 (two per temple)",
};

/** Whether the paired glasses can stream their microphones separately (G2, with the microphone channel in use). */
export function separateMicsSupported(): boolean {
  return glassesTypeSetting.get() === "g2" && micControlSupported();
}

/**
 * How many of the glasses' microphones Transcribe captures. With more than
 * one, the temples stream their own microphones (each temple on its own
 * clock) instead of the glasses' mixed stream; a recording keeps every one,
 * and what is transcribed is a mix made on the phone.
 */
export const transcribeMicsSetting = new ConfigSettingEnum<TranscribeMics>({
  id: "transcribe-mics",
  label: "Microphones",
  storageKey: "transcribe.mics",
  defaultValue: "1",
  values: ["1", "2", "4"],
  formatValue: (value) => MICS_LABELS[value],
  isDisabled: (value) => value !== "1" && !separateMicsSupported(),
  description:
    "Which of the glasses' microphones to capture. 1 is the glasses' own mixed stream. 2 and 4 stream each temple's microphones separately (custom firmware), so a saved recording has every microphone on its own channel; the transcript then comes from a mix made on the phone.",
});

/** The setting as a capture option; 1 where the glasses can't stream their microphones separately. */
export function transcribeMicCount(): MicCount {
  if (!separateMicsSupported()) return 1;
  return Number(transcribeMicsSetting.get()) as MicCount;
}
