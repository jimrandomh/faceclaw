import { FaceclawCommunicatorBridge } from "./faceclaw-communicator.ios";

/**
 * Passive view of the glasses' audio traffic on iOS: the same API as
 * audio-monitor.ts over the running shared-Kotlin session. Nothing here sends
 * anything to the glasses.
 */

export type AudioArm = "L" | "R" | "?";

/** The session listeners attach to; changes across reconnects. */
export function audioMonitorCommunicator(): FaceclawCommunicatorBridge | null {
  return FaceclawCommunicatorBridge.getActive();
}

/** True while Faceclaw itself is forwarding glasses audio to one of its apps. */
export function isFaceclawAudioCaptureActive(): boolean {
  try {
    return Boolean(FaceclawCommunicatorBridge.getActive()?.isAudioCaptureActive());
  } catch {
    return false;
  }
}

/**
 * Subscribe `communicator` to every audio-characteristic packet and every
 * field-104 mic status record body (undecoded). Delivered on the main thread.
 * Returns an unsubscribe function.
 */
export function addAudioMonitorListeners(
  communicator: FaceclawCommunicatorBridge | null,
  onPacket: (data: Uint8Array, arm: AudioArm, arrivalMs: number) => void,
  onStatus: (body: Uint8Array, arm: AudioArm) => void,
): () => void {
  if (!communicator) return () => {};
  const offPackets = communicator.addAudioMonitorListener((data, arm, arrivalMs) => onPacket(data, toArm(arm), arrivalMs));
  const offStatus = communicator.addMicStatusListener((body, arm) => onStatus(body, toArm(arm)));
  return () => {
    try {
      offPackets();
      offStatus();
    } catch {
      // The session may have been closed during a disconnect.
    }
  };
}

function toArm(arm: string): AudioArm {
  return arm === "L" || arm === "R" ? arm : "?";
}
