import { isTerminalWidgetConfigured } from "../glanceboard/configuration";
import { loadConnections, parseConnectionString } from "./connections";

/** Keep session-list connections alive for a configured widget, even while it is hidden. */
export function hasTerminalBackgroundWork(): boolean {
  return isTerminalWidgetConfigured() &&
    loadConnections().some(connection => connection.enabled && parseConnectionString(connection.url) !== null);
}
