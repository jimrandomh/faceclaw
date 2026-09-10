declare const com: any;
declare const global: any;

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

function activeCommunicator(): any {
  if (!global.isAndroid) return null;
  try {
    return com.faceclaw.app.FaceclawBleCommunicator.getActive();
  } catch {
    return null;
  }
}

/**
 * Request CFW mode 10 to start/stop the stock firmware compass on behalf of
 * `owner`. The magnetometer is shared: it runs while any owner wants it and
 * stops once the last one releases it, so apps can't switch each other off.
 */
export function setCompassEnabled(enabled: boolean, owner = "compass"): void {
  try {
    activeCommunicator()?.setCompassEnabled(owner, enabled);
  } catch (error) {
    console.warn(`setCompassEnabled failed: ${error}`);
  }
}

/**
 * Subscribe to stock compass heading/calibration notifications. Events are
 * delivered on the calling thread's Looper, so this works from app workers.
 */
export function addCompassListener(listener: (event: CompassEvent) => void): () => void {
  const active = activeCommunicator();
  if (!active) return () => {};
  const proxy = new com.faceclaw.app.FaceclawCompassListener({
    onCompassEvent: (command: number, headingDegrees: number, magneticAccuracy: number,
      magneticAnomalies: number, orientationSource: number, diagnosticFlags: number, sampleTimeMs: number) => {
      listener({
        command: Number(command), headingDegrees: Number(headingDegrees),
        diagnostics: diagnosticFlags >= 0 ? {
          magneticAccuracy: Number(magneticAccuracy), magneticAnomalies: Number(magneticAnomalies),
          orientationSource: Number(orientationSource), flags: Number(diagnosticFlags),
          sampleTimeMs: Number(sampleTimeMs),
        } : undefined,
      });
    },
  });
  active.addCompassListener(proxy);
  return () => {
    try {
      activeCommunicator()?.removeCompassListener(proxy);
    } catch {
      // The communicator may have been replaced during a disconnect.
    }
  };
}
