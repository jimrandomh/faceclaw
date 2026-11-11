/**
 * The Meta Neural Band's gesture mapping and plain-language status, shared by
 * app/g2/neural-band.ts, the glasses' Settings (app/ui/dashboard/settings-menus.ts) and the
 * phone's Neural Band page. No NativeScript imports, so the node tests can load it.
 */
import type { NeuralBandStatus } from "../native/neural-band-types";

/** The synthetic inputs a band gesture can become (a subset of WearRemoteInputKind). */
export type NeuralBandInputKind =
  | "ring-press"
  | "click"
  | "double-click"
  | "short-then-long-press"
  | "swipe-up"
  | "swipe-down"
  | "swipe-left"
  | "swipe-right"
  | "scroll-up"
  | "scroll-down";

/**
 * What one gesture becomes, or null for the pinch edges handled as a pair (`hold` starts a
 * long-press that its `release` ends; see NeuralBandRemote). The mapping follows the ring's
 * vocabulary where it can, and Meta's conventions where the band has a gesture the ring lacks:
 *
 *   any pinch, at once         -> ring-press (touch-down, for games that act on it)
 *   index tap                  -> click (select)
 *   index or middle double tap -> double-click (back; wakes or sleeps the display)
 *   middle tap                 -> short-then-long-press (the app's menu)
 *   thumb swipe                -> swipe-up/down/left/right
 *   index pinch-and-twist      -> scroll-up/down
 */
export function neuralBandInputFor(gesture: string, finger: number | undefined): NeuralBandInputKind | null {
  switch (gesture) {
    case "press":
      return "ring-press";
    case "tap":
      return finger === 1 ? "short-then-long-press" : "click";
    case "double-tap":
      return "double-click";
    case "swipe-up":
    case "swipe-down":
    case "swipe-left":
    case "swipe-right":
      return gesture;
    case "dial-up":
      return "scroll-up";
    case "dial-down":
      return "scroll-down";
    default:
      return null;
  }
}

/**
 * The band's entry in the shell's battery levels: its level while connected, null otherwise
 * (so the indicator disappears with the band, as the watch's does). Charging stays null until
 * the band has said, which only its own status query does (the standard battery service doesn't).
 */
export function neuralBandBatteryLevel(status: NeuralBandStatus): { band: number | null; bandCharging: boolean | null } {
  const level = status.battery;
  if (status.state !== "connected" || !Number.isInteger(level) || level < 0 || level > 100) {
    return { band: null, bandCharging: null };
  }
  return { band: level, bandCharging: status.charging };
}

/** How long after the band last recognized a character its other gestures are ignored. */
export const HANDWRITING_GESTURE_QUIET_MS = 700;

/**
 * Whether a gesture should be dropped as a by-product of writing: while handwriting runs, a
 * finger tracing letters can also read as a tap or a swipe, and in the handwriting dialog a
 * tap sends. Releases always pass, so a hold that began before can end.
 */
export function suppressedWhileWriting(gesture: string, handwritingActive: boolean, sinceLastCharacterMs: number): boolean {
  return handwritingActive && gesture !== "release" && sinceLastCharacterMs < HANDWRITING_GESTURE_QUIET_MS;
}

/**
 * The handwriting dialog's view of the band model's state: switching on, writing, or stopped
 * (with why, when the band ended it on its own: a refused setting, silence, a dropped link).
 */
export function handwritingDialogPhase(
  phase: "idle" | "preparing" | "ready" | "restoring" | "finished",
  problem: string | undefined,
): { phase: "starting" | "ready" | "stopped"; message: string } {
  switch (phase) {
    case "preparing":
      return { phase: "starting", message: "Switching the band to handwriting…" };
    case "ready":
      return { phase: "ready", message: "" };
    default:
      if (problem?.includes(NO_MODEL_CONTROLS)) return { phase: "stopped", message: NO_HANDWRITING_FIRMWARE };
      return { phase: "stopped", message: problem ? `Handwriting stopped: ${problem}` : "Handwriting stopped." };
  }
}

/** BAND_NO_MODEL_CONTROLS (BandModelCapture.kt): the band's firmware has no handwriting controls. */
const NO_MODEL_CONTROLS = "model controls are unavailable on this band";
export const NO_HANDWRITING_FIRMWARE = "This band's firmware has no handwriting controls. A newer band firmware may add them.";

/** The band's name, or a generic one before it has said. */
export function neuralBandName(status: NeuralBandStatus): string {
  return status.name || "Neural Band";
}

/** "84%" / "84%, charging"; "" while unknown. */
export function neuralBandBatteryText(status: NeuralBandStatus): string {
  if (status.battery < 0) return "";
  return status.charging ? `${status.battery}%, charging` : `${status.battery}%`;
}

/** One line on where the band is, for the glasses' Settings and the top of the phone page. */
export function neuralBandStatusLine(status: NeuralBandStatus): string {
  if (!status.supported) return "This phone can't connect to a Meta Neural Band (it needs Android 10 or later).";
  if (!status.paired) {
    return "No band paired. Pair one from the phone app: Neural Band in the menu.";
  }
  const name = neuralBandName(status);
  switch (status.state) {
    case "connected": {
      const battery = neuralBandBatteryText(status);
      return battery ? `Connected to ${name} (${battery}).` : `Connected to ${name}.`;
    }
    case "connecting":
      return status.message ? `Connecting to ${name}: ${status.message}` : `Connecting to ${name}…`;
    case "claiming":
      return status.message ? `Setting up ${name}: ${status.message}` : `Setting up ${name}…`;
    case "error":
      return status.message ? `${name}: ${status.message}` : `${name} couldn't connect.`;
    default:
      return `${name} is paired but not connected.`;
  }
}
