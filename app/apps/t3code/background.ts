import { isT3CodeWidgetInUse } from "../glanceboard/configuration";
import { loadEnvironments } from "./t3-environments";

/**
 * Keep the T3 worker (and its server connections) running with no window
 * open, for the Glanceboard widget. The app's boot hook spawns the worker
 * whenever this turns true; the worker reports idle once it turns false.
 */
export function hasT3BackgroundWork(): boolean {
  return isT3CodeWidgetInUse() && loadEnvironments().some((environment) => environment.enabled);
}
