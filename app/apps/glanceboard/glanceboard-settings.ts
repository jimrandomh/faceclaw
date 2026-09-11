import { ConfigSettingBoolean, ConfigSettingEnum } from "../../ui/dashboard-settings";
import { QUADRANT_LAYOUT, type GlanceLayout } from "./layout";
import { type GlanceWidgetId } from "./widget";

export type GlanceSlotChoice = GlanceWidgetId | "none";

const SLOT_CHOICES: readonly GlanceSlotChoice[] = ["none", "system-card", "nightscout", "compass", "music"];

const SLOT_CHOICE_LABELS: Record<GlanceSlotChoice, string> = {
  none: "Empty",
  "system-card": "System card",
  nightscout: "Nightscout",
  compass: "Compass",
  music: "Music",
};

export function glanceSlotChoiceLabel(choice: GlanceSlotChoice): string {
  return SLOT_CHOICE_LABELS[choice] ?? choice;
}

const DEFAULT_QUADRANT_CHOICES: readonly GlanceSlotChoice[] = ["system-card", "music", "compass", "nightscout"];

/**
 * Whether sleep-time gestures show the board at all. Off restores the plain
 * behaviour: a tap or hold while asleep does nothing, double-tap wakes.
 */
export const glanceboardEnabledSetting = new ConfigSettingBoolean({
  id: "glanceboard-enabled",
  label: "Show on tap while asleep",
  storageKey: "glanceboard.enabled",
  defaultValue: true,
  description:
    "While the display is asleep, a single tap shows the Glanceboard for a few seconds and a long-press holds it up until released. Double-tap still wakes the regular UI.",
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
