declare const com: any;

/**
 * Head-up (look-up wake) trigger on the active glasses session
 * (GlassesSessionCore.setHeadUpTrigger / getHeadUpStatus). Android only for
 * now (headUpControlsAvailable): on iOS, or with no session, the setter does
 * nothing and the getter returns null.
 */

/** Whether this platform can change the glasses' head-up setting at all. */
export function headUpControlsAvailable(): boolean {
  return Boolean(global.isAndroid);
}

/** GlassesSessionCore.getHeadUpStatus. switch -1 = not read on this connection. */
export type HeadUpStatus = {
  switch: number;
  angle: number;
  calibration: number;
  /** The trigger Faceclaw is maintaining, or -1 when it leaves the glasses' own setting. */
  desired: number;
  readAgeMs: number;
  /** The glasses' own switch and angle from before Faceclaw changed them (switch -1 = none held). */
  originalSwitch: number;
  originalAngle: number;
  /** Those originals are being written back. */
  restorePending: boolean;
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
 * Ask the session to keep the head-up trigger at `degrees` (1..90); 0 stops
 * managing it and writes back `original` (or what the session saved itself)
 * if Faceclaw changed the glasses' values.
 */
export function setHeadUpTrigger(degrees: number, original: { switch: number; angle: number } | null = null): boolean {
  const active = activeCommunicator();
  if (!active) return false;
  try {
    active.setHeadUpTrigger(Math.round(degrees), original ? original.switch : -1, original ? Math.round(original.angle) : 0);
    return true;
  } catch (error) {
    console.warn(`setHeadUpTrigger failed: ${error}`);
    return false;
  }
}

export function getHeadUpStatus(): HeadUpStatus | null {
  const active = activeCommunicator();
  if (!active) return null;
  try {
    return JSON.parse(String(active.getHeadUpStatus())) as HeadUpStatus;
  } catch (error) {
    console.warn(`getHeadUpStatus failed: ${error}`);
    return null;
  }
}
