import { getBooleanSetting, getStringSetting } from "../../native/settings-store";
import { QUADRANT_LAYOUT, SIX_SLOT_LAYOUT } from "./layout";

/** Whether the current layout has `widgetId` in any slot (configuration only, enabled or not). */
function isGlanceWidgetConfigured(widgetId: string): boolean {
  const layout = getStringSetting("glanceboard.layout", "2x2") === "2x3" ? SIX_SLOT_LAYOUT : QUADRANT_LAYOUT;
  // Both layouts store their slots under the original quadrants key. None
  // of the default slots needs a worker, so absent keys cannot retain one.
  return layout.slots.some((_, index) =>
    getStringSetting(`glanceboard.${QUADRANT_LAYOUT.id}.slot.${index}`, "none") === widgetId);
}

/** Configuration-only query usable by workers without loading widget/UI modules. */
export function isTerminalWidgetConfigured(): boolean {
  return isGlanceWidgetConfigured("terminal");
}

/**
 * Whether the T3 Code widget can show: it is in a slot and the Glanceboard is
 * enabled (the T3 worker holds its server connections open only then).
 */
export function isT3CodeWidgetInUse(): boolean {
  return getBooleanSetting("glanceboard.enabled", false) && isGlanceWidgetConfigured("t3code");
}
