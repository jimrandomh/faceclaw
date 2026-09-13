import { ConfigSettingBoolean, ConfigSettingEnum } from "../../ui/dashboard-settings";
import { QUADRANT_LAYOUT, slotsVerticallyAdjacent, type GlanceLayout } from "./layout";
import { type GlanceWidgetId } from "./widget";
import { glanceWidgetSpans } from "./widgets";

export type GlanceSlotChoice = GlanceWidgetId | "none";

const SLOT_CHOICES: readonly GlanceSlotChoice[] = ["none", "system-card", "calendar", "terminal", "nightscout", "compass", "music"];

const SLOT_CHOICE_LABELS: Record<GlanceSlotChoice, string> = {
  none: "Empty",
  "system-card": "System card",
  calendar: "Calendar",
  terminal: "Terminal",
  nightscout: "Nightscout",
  compass: "Compass",
  music: "Music",
};

export function glanceSlotChoiceLabel(choice: GlanceSlotChoice): string {
  return SLOT_CHOICE_LABELS[choice] ?? choice;
}

/**
 * Slot order follows QUADRANT_LAYOUT: top left, top right, bottom left, bottom
 * right. Calendar in both right slots merges into one double-height region.
 */
const DEFAULT_QUADRANT_CHOICES: readonly GlanceSlotChoice[] = ["system-card", "calendar", "music", "calendar"];

/**
 * Whether sleep-time gestures show the board at all. Off restores the plain
 * behaviour: a tap, hold or head-tilt while asleep does nothing (a head-tilt
 * wakes the regular UI), double-tap wakes.
 */
export const glanceboardEnabledSetting = new ConfigSettingBoolean({
  id: "glanceboard-enabled",
  label: "Enable Glanceboard",
  storageKey: "glanceboard.enabled",
  defaultValue: false,
  description:
    "While the display is asleep, a tap, a long-press or a head-tilt shows the Glanceboard instead of the regular UI. Double-tap still wakes the regular UI.",
});

export type GlanceTapDuration = "off" | "3s" | "5s" | "7s" | "10s";

const DEFAULT_TAP_DURATION: GlanceTapDuration = "5s";

/**
 * How long a tap (or head-tilt) keeps the board up; each further tap restarts
 * it. "off" means a single tap does not show the board at all; a head-tilt
 * then uses the default duration.
 */
export const glanceTapDurationSetting = new ConfigSettingEnum<GlanceTapDuration>({
  id: "glanceboard-tap-duration",
  label: "Show on tap",
  storageKey: "glanceboard.tapDuration",
  defaultValue: DEFAULT_TAP_DURATION,
  values: ["off", "3s", "5s", "7s", "10s"],
  formatValue: (value) => (value === "off" ? "Disabled" : value.replace("s", " s")),
  description:
    "How long a single tap (or a head-tilt) keeps the Glanceboard on screen. Disabled: a single tap does not show the Glanceboard.",
});

/** Whether a single tap while asleep shows the board. */
export function glanceShowOnTap(): boolean {
  return glanceTapDurationSetting.get() !== "off";
}

export function glanceTapTimeoutMs(): number {
  const duration = glanceTapDurationSetting.get();
  const seconds = duration === "off" ? DEFAULT_TAP_DURATION : duration;
  return Number.parseInt(seconds, 10) * 1000;
}

/** A long-press holds the board up until the press is released. */
export const glanceShowOnLongPressSetting = new ConfigSettingBoolean({
  id: "glanceboard-show-on-long-press",
  label: "Show on long press",
  storageKey: "glanceboard.showOnLongPress",
  defaultValue: true,
  description: "Holding a long-press while asleep shows the Glanceboard until the press is released.",
});

/** The head-tilt wake shows the board (for the tap duration) instead of the regular UI. */
export const glanceShowOnHeadTiltSetting = new ConfigSettingBoolean({
  id: "glanceboard-show-on-head-tilt",
  label: "Show on head tilt",
  storageKey: "glanceboard.showOnHeadTilt",
  defaultValue: true,
  description: "Tilting your head up while asleep shows the Glanceboard instead of waking the regular UI.",
});

/** Hairlines between the board's slots. */
export const glanceShowLinesSetting = new ConfigSettingBoolean({
  id: "glanceboard-show-lines",
  label: "Show lines",
  storageKey: "glanceboard.showLines",
  defaultValue: true,
  description: "Draw the separator lines between the Glanceboard's slots.",
});

/**
 * One picker per layout slot, keyed by layout id and slot index so a future
 * layout gets its own stored choices rather than inheriting the quadrants'.
 */
export function glanceSlotSettings(layout: GlanceLayout = QUADRANT_LAYOUT): ConfigSettingEnum<GlanceSlotChoice>[] {
  return layout.slots.map(
    (slot, index) =>
      new ConfigSettingEnum<GlanceSlotChoice>({
        id: `glanceboard-${layout.id}-slot-${index}`,
        label: slot.label,
        storageKey: `glanceboard.${layout.id}.slot.${index}`,
        defaultValue: (layout === QUADRANT_LAYOUT ? DEFAULT_QUADRANT_CHOICES[index] : undefined) ?? "none",
        values: SLOT_CHOICES,
        formatValue: glanceSlotChoiceLabel,
        description: `Which widget fills the ${slot.label.toLowerCase()} slot of the Glanceboard.`,
      }),
  );
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
  settings.forEach((setting, index) => {
    if (index === changedIndex || setting.get() !== choice) return;
    if (spans && slotsVerticallyAdjacent(layout, changedIndex, index)) return;
    setting.set("none");
    cleared.push(index);
  });
  return cleared;
}
