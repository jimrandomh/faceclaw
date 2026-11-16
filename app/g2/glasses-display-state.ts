export type GlassesDisplayState = {
  phase: string;
  silentMode: boolean;
  screenOn: boolean;
  battery: number | null;
  /** The paired glasses' model, e.g. "G2" (glassesModelName). */
  glassesModel: string;
  /**
   * The charging case's last-known level, and whether it is on USB (null
   * while the glasses are out of the case). Shown only while charging, when
   * the glasses are docked and the case reading is live.
   */
  caseBattery: number | null;
  caseCharging: boolean | null;
  foregroundTitle: string | null;
  /** The headless preview display is standing in for a connection (preview-only mode). */
  previewMode: boolean;
};

/** Compact status shown where the foreground-window title normally lives. */
export function glassesDisplayLabel(state: GlassesDisplayState): string {
  // Charging wins over every session-local state: the glasses are in their
  // case, so neither the lock screen nor the foreground window is visible.
  if (state.phase === "charging") {
    return chargingDisplayLabel(state.battery, state.glassesModel);
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
 * The smaller line under that label on the watch face, or "": the case
 * level while the glasses charge in it.
 */
export function glassesDisplayDetail(state: GlassesDisplayState): string {
  if (state.phase !== "charging") return "";
  return validBatteryLevel(state.caseBattery) ? batteryEntry("Case", state.caseBattery, state.caseCharging) : "";
}

/** The phone mirror's stand-in while charging: the label and its detail on one line. */
export function chargingPreviewMessage(state: GlassesDisplayState): string {
  return [glassesDisplayLabel(state), glassesDisplayDetail(state)].filter(Boolean).join(" · ");
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

export function chargingDisplayLabel(battery: number | null, glassesModel: string): string {
  return validBatteryLevel(battery) ? `Charging: ${glassesModel} ${battery}%` : "Charging";
}

/** The shell's last-known battery levels (ShellChromeState["battery"]), as far as the phone shows them. */
export type BatteryLevels = {
  headset: number | null;
  headsetCharging: boolean | null;
  case: number | null;
  caseCharging: boolean | null;
  ring: number | null;
  ringCharging: boolean | null;
};

/**
 * The phone settings page's battery row: each device whose level is known,
 * e.g. "G2 100%  ·  Case 98% ⚡  ·  R1 72%" (⚡ = charging), or "" when none
 * is. Levels are the last known ones (the case only reports while the glasses
 * are docked), so ⚡ appears only while it is live: the glasses and Case only
 * with a link to the glasses (`glassesLinked`: connected or charging), and Case
 * only while they are docked (caseCharging is null otherwise).
 */
export function formatBatteryLine(levels: BatteryLevels, glassesLinked: boolean, glassesModel: string): string {
  const devices: Array<[string, number | null, boolean | null]> = [
    [glassesModel, levels.headset, glassesLinked && levels.headsetCharging],
    ["Case", levels.case, glassesLinked && levels.caseCharging],
    ["R1", levels.ring, levels.ringCharging],
  ];
  return devices
    .filter((device): device is [string, number, boolean | null] => validBatteryLevel(device[1]))
    .map(([label, level, charging]) => batteryEntry(label, level, charging))
    .join("  ·  ");
}

function batteryEntry(label: string, level: number, charging: boolean | null): string {
  return `${label} ${level}%${charging ? " ⚡" : ""}`;
}

function validBatteryLevel(battery: number | null): battery is number {
  return battery !== null && Number.isInteger(battery) && battery >= 0 && battery <= 100;
}
