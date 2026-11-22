import { getBooleanSetting, setBooleanSetting } from "../native/settings-store";
import { defaultRingName } from "../native/ring-status";
import type { RingConnectionMode } from "../ui/dashboard-settings";

/**
 * Per-connection R1 ring setup shared by the Android dashboard controller and
 * the iOS preview controller.
 */

/** Set while a Direct ring session may have taken the R1 from the glasses; see handRingBackToGlassesIfNeeded. */
const RING_TAKEN_FROM_GLASSES_KEY = "developer.ringTakenFromGlasses";

/**
 * The ring role the direct link claims (GlassesSessionCore.setDirectRingRole).
 * Direct mode acts as the ring's glasses, the only role the ring sends
 * gestures and battery to. Health sync needs the phone role, which the
 * session borrows briefly for each pull (GlassesSessionRing.beginRingHealthWindowLocked).
 */
export function directRingRole(mode: RingConnectionMode): "glasses" | "phone" {
  return mode === "direct" ? "glasses" : "phone";
}

/**
 * Call when a session starts. A Direct session may unpair the ring from the
 * glasses (GlassesSessionRing.releaseRingFromGlassesLocked), so remember to
 * hand it back once a later session runs in another mode.
 */
export function noteRingSessionMode(mode: RingConnectionMode, ringAddress: string): void {
  if (mode === "direct" && ringAddress) setBooleanSetting(RING_TAKEN_FROM_GLASSES_KEY, true);
}

/**
 * The first G2 session in another mode after a Direct one asks the glasses to
 * connect to the ring again; the ring's own glasses targets were cleared, so
 * it accepts them. `connect` sends RING_CONNECT_INFO connect=1 and returns
 * false when the session could not queue it, leaving the hand-back for the
 * next connection. Call on connect; returns true when it was sent.
 */
export function handRingBackToGlassesIfNeeded(
  mode: RingConnectionMode,
  ringAddress: string,
  connect: (address: string, name: string) => boolean,
): boolean {
  if (mode === "direct" || !getBooleanSetting(RING_TAKEN_FROM_GLASSES_KEY, false)) return false;
  if (!ringAddress) {
    setBooleanSetting(RING_TAKEN_FROM_GLASSES_KEY, false);
    return false;
  }
  if (!connect(ringAddress, defaultRingName(ringAddress))) return false;
  setBooleanSetting(RING_TAKEN_FROM_GLASSES_KEY, false);
  return true;
}
