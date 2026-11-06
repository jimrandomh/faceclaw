declare const com: any;

/**
 * Head-up (look-up wake) trigger on the active glasses session
 * (GlassesSessionCore.setHeadUpTrigger / getHeadUpStatus). Android only for
 * now: on iOS, or with no session, the setter does nothing and the getter
 * returns null.
 */

/** GlassesSessionCore.getHeadUpStatus. switch -1 = not read on this connection. */
export type HeadUpStatus = {
  switch: number;
  angle: number;
  calibration: number;
  /** The trigger Faceclaw is maintaining, or -1 when it leaves the glasses' own setting. */
  desired: number;
  readAgeMs: number;
};

function activeCommunicator(): any {
  if (!global.isAndroid) return null;
  try {
    return com.faceclaw.app.FaceclawBleCommunicator.getActive();
  } catch {
    return null;
  }
}

/** Ask the session to keep the head-up trigger at `degrees` (1..90); 0 stops managing it. */
export function setHeadUpTrigger(degrees: number): boolean {
  const active = activeCommunicator();
  if (!active) return false;
  try {
    active.setHeadUpTrigger(Math.round(degrees));
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
