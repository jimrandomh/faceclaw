import { ConfigSettingBoolean, ConfigSettingEnum, glassesHaveCompass } from "../../ui/dashboard-settings";
import { QUADRANT_LAYOUT, SIX_SLOT_LAYOUT, slotsVerticallyAdjacent, type GlanceLayout } from "./layout";
import { type GlanceWidgetId } from "./widget";
import { glanceWidgetSpans } from "./widgets";

export type GlanceSlotChoice = GlanceWidgetId | "none";

const SLOT_CHOICES: readonly GlanceSlotChoice[] = ["none", "system-card", "calendar", "terminal", "t3code", "nightscout", "compass", "music", "health"];

const SLOT_CHOICE_LABELS: Record<GlanceSlotChoice, string> = {
  none: "Empty",
  "system-card": "System card",
  calendar: "Calendar",
  terminal: "Terminal",
  t3code: "T3 Code",
  nightscout: "Nightscout",
  compass: "Compass",
  music: "Music",
  health: "Health",
};

export function glanceSlotChoiceLabel(choice: GlanceSlotChoice): string {
  return SLOT_CHOICE_LABELS[choice] ?? choice;
}

/** Whether the paired glasses can drive this widget; if not, it is left out of the slot picker. */
function slotChoiceAvailable(choice: GlanceSlotChoice): boolean {
  return choice !== "compass" || glassesHaveCompass();
}

/**
 * Slot order follows QUADRANT_LAYOUT: top left, top right, bottom left, bottom
 * right. Calendar in both right slots merges into one double-height region.
 */
const DEFAULT_QUADRANT_CHOICES: readonly GlanceSlotChoice[] = ["system-card", "calendar", "music", "calendar"];

export const glanceLayoutSetting = new ConfigSettingEnum<"2x2" | "2x3">({
  id: "glanceboard-layout",
  label: "Layout",
  storageKey: "glanceboard.layout",
  defaultValue: "2x2",
  values: ["2x2", "2x3"],
  description: "Choose two columns with two or three rows of widgets.",
});

export function glanceLayout(): GlanceLayout {
  return glanceLayoutSetting.get() === "2x3" ? SIX_SLOT_LAYOUT : QUADRANT_LAYOUT;
}

/**
 * Whether sleep-time gestures show the board at all. Off restores the plain
 * behaviour: a tap or hold while asleep does nothing, a head-tilt wakes the
 * regular UI, double-tap wakes; and the head-up angle goes back to the glasses'
 * own.
 */
export const glanceboardEnabledSetting = new ConfigSettingBoolean({
  id: "glanceboard-enabled",
  label: "Enable Glanceboard",
  storageKey: "glanceboard.enabled",
  defaultValue: false,
  description:
    "While the display is asleep, a tap, a long-press or a head-tilt shows the Glanceboard instead of the regular UI. Double-tap still wakes the regular UI.",
});

const TAP_DURATION_SECONDS = {
  "3s": 3,
  "5s": 5,
  "7s": 7,
  "10s": 10,
  "20s": 20,
  "30s": 30,
  "1min": 60,
} as const;

type GlanceTapDurationTimed = keyof typeof TAP_DURATION_SECONDS;
export type GlanceTapDuration = "off" | GlanceTapDurationTimed;

const TAP_DURATION_VALUES: readonly GlanceTapDuration[] = ["off", ...(Object.keys(TAP_DURATION_SECONDS) as GlanceTapDurationTimed[])];

const DEFAULT_TAP_DURATION: GlanceTapDurationTimed = "5s";

function formatTapDuration(value: GlanceTapDuration): string {
  if (value === "off") return "Disabled";
  const seconds = TAP_DURATION_SECONDS[value];
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

/**
 * How long a tap keeps the board up; each further tap restarts it. "off"
 * means a single tap does not show the board at all. A head-tilt showing
 * lasts until the head comes back down, falling back to this duration (the
 * default one when "off") where the head-down is unlikely to arrive.
 */
export const glanceTapDurationSetting = new ConfigSettingEnum<GlanceTapDuration>({
  id: "glanceboard-tap-duration",
  label: "Show on tap",
  storageKey: "glanceboard.tapDuration",
  defaultValue: DEFAULT_TAP_DURATION,
  values: TAP_DURATION_VALUES,
  formatValue: formatTapDuration,
  description:
    "How long a single tap keeps the Glanceboard on screen. Disabled: a single tap does not show the Glanceboard.",
});

/** Whether a single tap while asleep shows the board. */
export function glanceShowOnTap(): boolean {
  return glanceTapDurationSetting.get() !== "off";
}

export function glanceTapTimeoutMs(): number {
  const duration = glanceTapDurationSetting.get();
  return TAP_DURATION_SECONDS[duration === "off" ? DEFAULT_TAP_DURATION : duration] * 1000;
}

/** A long-press holds the board up until the press is released. */
export const glanceShowOnLongPressSetting = new ConfigSettingBoolean({
  id: "glanceboard-show-on-long-press",
  label: "Show on long press",
  storageKey: "glanceboard.showOnLongPress",
  defaultValue: true,
  description: "A long-press or short-then-long-press while asleep shows the Glanceboard until the press is released.",
});

/** The head-tilt wake shows the board (until the head comes back down) instead of the regular UI. */
export const glanceShowOnHeadTiltSetting = new ConfigSettingBoolean({
  id: "glanceboard-show-on-head-tilt",
  label: "Show on head tilt",
  storageKey: "glanceboard.showOnHeadTilt",
  defaultValue: true,
  description: "Tilting your head up while asleep shows the Glanceboard instead of waking the regular UI. It stays up until you look back down.",
});

export type GlanceTiltTimeout = "60s" | "30s" | "15s" | "10s" | "never";

/**
 * How long a head-tilt showing may last if the head-down never comes (the
 * board normally hides when the head comes back down). "never" removes the
 * limit; a double-tap still dismisses the board.
 */
export const glanceTiltTimeoutSetting = new ConfigSettingEnum<GlanceTiltTimeout>({
  id: "glanceboard-head-tilt-timeout",
  label: "Head tilt timeout",
  storageKey: "glanceboard.headTiltTimeout",
  defaultValue: "60s",
  values: ["60s", "30s", "15s", "10s", "never"],
  formatValue: (value) => (value === "never" ? "Never" : value.replace("s", " s")),
  description:
    "The longest a head-tilt keeps the Glanceboard up when looking back down is not detected. Never: it stays until you look down or double-tap. " +
    "When looking down is unlikely to register (a low Head tilt angle, or the display was suspended), the tap duration applies if shorter.",
});

/** The Head tilt timeout in ms, or null for none. */
export function glanceTiltTimeoutMs(): number | null {
  const value = glanceTiltTimeoutSetting.get();
  return value === "never" ? null : Number.parseInt(value, 10) * 1000;
}

const GLANCE_ANGLE_VALUES = ["glasses", "5", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55", "60"] as const;
export type GlanceAngle = (typeof GLANCE_ANGLE_VALUES)[number];

/**
 * How far the head must tilt up for a head-tilt wake, as the glasses' own
 * pitch reading (degrees). "glasses" keeps the glasses' own setting (from the
 * Even app), writing back their original values if Faceclaw changed them. A
 * number is written to the glasses' head-up setting on every connection while
 * the Glanceboard is enabled (head-angle.ts). Android only.
 */
export const glanceAngleSetting = new ConfigSettingEnum<GlanceAngle>({
  id: "glanceboard-head-tilt-angle",
  label: "Head tilt angle",
  storageKey: "glanceboard.headTiltAngle",
  defaultValue: "glasses",
  values: GLANCE_ANGLE_VALUES,
  formatValue: (value) => (value === "glasses" ? "Glasses default" : `${value}°`),
  description:
    "How far you tilt your head up to wake the display. Glasses default uses the glasses' own setting from the Even app. " +
    "The board hides when your head drops 20° below this angle; under 25°, looking straight ahead may not count, so it hides after the tap duration instead.",
});

/**
 * The trigger Faceclaw should maintain, in degrees: the Head tilt angle while
 * the Glanceboard is enabled, else 0 (the glasses' own setting).
 */
export function glanceAngleTriggerDegrees(): number {
  const value = glanceAngleSetting.get();
  return value === "glasses" || !glanceboardEnabledSetting.get() ? 0 : Number(value);
}

const DEPTH_VALUES = ["-64", "-48", "-32", "-16", "0", "16", "32", "48", "64"] as const;
export type GlanceDepth = (typeof DEPTH_VALUES)[number];

/**
 * Stereo depth of the board, in the firmware's depth units: the lenses shift
 * it by half this many pixels each, in opposite directions.
 */
export const glanceDepthSetting = new ConfigSettingEnum<GlanceDepth>({
  id: "glanceboard-depth",
  label: "Depth",
  storageKey: "glanceboard.depth",
  defaultValue: "0",
  values: DEPTH_VALUES,
  formatValue: (value) => {
    const depth = Number(value);
    return depth === 0 ? "0" : depth > 0 ? `+${depth} (nearer)` : `${depth} (farther)`;
  },
  description:
    "Moves the Glanceboard nearer (positive) or farther away (negative) by shifting it in opposite directions on the two lenses.",
});

export function glanceDepth(): number {
  return Number(glanceDepthSetting.get());
}

/** Hairlines between the board's slots. */
export const glanceShowLinesSetting = new ConfigSettingBoolean({
  id: "glanceboard-show-lines",
  label: "Show lines",
  storageKey: "glanceboard.showLines",
  defaultValue: true,
  description: "Draw the separator lines between the Glanceboard's slots.",
});

/**
 * Both grid sizes share the original storage keys so changing row count
 * preserves the first four choices and remembers the hidden bottom row.
 */
export function glanceSlotSettings(layout: GlanceLayout = glanceLayout()): ConfigSettingEnum<GlanceSlotChoice>[] {
  const grid = layout === QUADRANT_LAYOUT || layout === SIX_SLOT_LAYOUT;
  const storageId = grid ? QUADRANT_LAYOUT.id : layout.id;
  return layout.slots.map((slot, index) => {
    const defaultValue: GlanceSlotChoice = (grid ? DEFAULT_QUADRANT_CHOICES[index] : undefined) ?? "none";
    return new ConfigSettingEnum<GlanceSlotChoice>({
      id: `glanceboard-${layout.id}-slot-${index}`,
      label: slot.label,
      storageKey: `glanceboard.${storageId}.slot.${index}`,
      defaultValue,
      values: SLOT_CHOICES.filter(slotChoiceAvailable),
      // A stored choice the glasses can't drive reads as Empty, not the slot's
      // default (which could put a widget on the board twice). The stored value
      // stays, so pairing glasses that can drive it brings it back.
      normalize: (value) => {
        const choice = value as GlanceSlotChoice;
        if (!SLOT_CHOICES.includes(choice)) return defaultValue;
        return slotChoiceAvailable(choice) ? choice : "none";
      },
      formatValue: glanceSlotChoiceLabel,
      description: `Which widget fills the ${slot.label.toLowerCase()} slot of the Glanceboard.`,
    });
  });
}

/**
 * A slot was just set to `choice`: each widget appears on the board once, so
 * clear every other slot holding the same choice, except a vertically
 * adjacent one when the widget can span two slots (it then renders at
 * double height). Returns the indices cleared.
 */
export function clearConflictingSlots(layout: GlanceLayout, changedIndex: number, choice: GlanceSlotChoice): number[] {
  if (choice === "none") return [];
  const settings = glanceSlotSettings(layout);
  const spans = glanceWidgetSpans(choice);
  const cleared: number[] = [];
  let keptPartner = false;
  settings.forEach((setting, index) => {
    if (index === changedIndex || setting.get() !== choice) return;
    if (spans && !keptPartner && slotsVerticallyAdjacent(layout, changedIndex, index)) {
      keptPartner = true;
      return;
    }
    setting.set("none");
    cleared.push(index);
  });
  return cleared;
}
