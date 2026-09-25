import { getStringSetting } from "../../native/settings-store";
import { QUADRANT_LAYOUT, SIX_SLOT_LAYOUT } from "./layout";

/** Configuration-only query usable by workers without loading widget/UI modules. */
export function isTerminalWidgetConfigured(): boolean {
  const layout = getStringSetting("glanceboard.layout", "2x2") === "2x3" ? SIX_SLOT_LAYOUT : QUADRANT_LAYOUT;
  // Both layouts store their slots under the original quadrants key. None
  // of the default slots needs a worker, so absent keys cannot retain one.
  return layout.slots.some((_, index) =>
    getStringSetting(`glanceboard.${QUADRANT_LAYOUT.id}.slot.${index}`, "none") === "terminal");
}
