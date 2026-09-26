export const COMPASS_CHANGED = 15;
export const COMPASS_CALIBRATION_STARTED = 16;
export const COMPASS_CALIBRATION_COMPLETE = 17;

export type CompassDiagnostics = {
  /** 0 uncalibrated .. 3 well calibrated; -1 unavailable. */
  magneticAccuracy: number;
  /** 0 none, 1 small/temperature, 2 large; -1 unavailable. */
  magneticAnomalies: number;
  /** 0 unknown, 1 GRV (relative), 2 GMRV, 3 RV. */
  orientationSource: number;
  flags: number;
  sampleTimeMs: number;
};

export type CompassEvent = {
  command: number;
  /** Magnetic heading in degrees, or -1 for calibration-only events. */
  headingDegrees: number;
  /** Absent with stock/older CFW or an unrecognized diagnostic extension. */
  diagnostics?: CompassDiagnostics;
};

