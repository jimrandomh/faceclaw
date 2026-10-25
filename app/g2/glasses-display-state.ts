export type GlassesDisplayState = {
  phase: string;
  silentMode: boolean;
  screenOn: boolean;
  battery: number | null;
  foregroundTitle: string | null;
  /** The headless preview display is standing in for a connection (preview-only mode). */
  previewMode: boolean;
};

/** Compact status shown where the foreground-window title normally lives. */
export function glassesDisplayLabel(state: GlassesDisplayState): string {
  // Charging wins over every session-local state: the glasses are in their
  // case, so neither the lock screen nor the foreground window is visible.
  if (state.phase === "charging") {
    return chargingDisplayLabel(state.battery);
  }
  // Preview mode has a live (simulated) screen despite the disconnected
  // phase, so fall through to the screen-state/foreground labels.
  if (state.phase !== "connected" && !state.previewMode) {
    return "Glasses disconnected";
  }
  if (state.silentMode) {
    return "Silent mode";
  }
  if (glassesDisplayAsleep(state)) {
    return "Display off";
  }
  return state.foregroundTitle || "Launcher";
}

/**
 * True when the label reads "Display off": the screen is dark but the glasses
 * (or the preview standing in for them) would light it on a wake gesture.
 */
export function glassesDisplayAsleep(state: GlassesDisplayState): boolean {
  return (
    state.phase !== "charging" &&
    (state.phase === "connected" || state.previewMode) &&
    !state.silentMode &&
    !state.screenOn
  );
}

export function chargingDisplayLabel(battery: number | null): string {
  return validBatteryLevel(battery) ? `Charging · G2 ${battery}%` : "Charging";
}

function validBatteryLevel(battery: number | null): battery is number {
  return battery !== null && Number.isInteger(battery) && battery >= 0 && battery <= 100;
}
