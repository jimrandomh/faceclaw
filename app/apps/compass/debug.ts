import type { CompassDiagnostics } from "../../native/compass";
import { getBooleanSetting, setBooleanSetting } from "../../native/settings-store";

const DEBUG_KEY = "compass.debugInfo";

export function isCompassDebugEnabled(): boolean {
  return getBooleanSetting(DEBUG_KEY, false);
}

export function setCompassDebugEnabled(enabled: boolean): void {
  setBooleanSetting(DEBUG_KEY, enabled);
}

export function compassDebugLines(diagnostics: CompassDiagnostics | null): string[] {
  if (!diagnostics) return ["Diagnostics", "unavailable"];
  if (!(diagnostics.flags & 0x80)) return ["Sample data", "unavailable"];
  const accuracy = diagnostics.magneticAccuracy < 0 ? "--" : `${diagnostics.magneticAccuracy}/3`;
  const anomalies = diagnostics.magneticAnomalies < 0 ? "--" : String(diagnostics.magneticAnomalies);
  const source = ["--", "GRV", "GMRV", "RV"][diagnostics.orientationSource] ?? "--";
  return [`Mag: ${accuracy}`, `Anom: ${anomalies}`, `Src: ${source}`];
}
