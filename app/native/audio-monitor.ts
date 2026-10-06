/**
 * Passive view of the glasses' audio traffic, for diagnostics. Nothing here
 * sends anything to the glasses: the listeners only observe packets and CFW
 * mic_control status records that arrive because something else (a stock
 * EvenHub mic enable, or a CFW mic_control CONFIGURE) turned the mics on.
 */
import { toUint8Array } from "../util/array-util";

declare const com: any;
declare const global: any;

export type AudioArm = "L" | "R" | "?";

function activeCommunicator(): any {
  if (!global.isAndroid) return null;
  try {
    return com.faceclaw.app.FaceclawBleCommunicator.getActive();
  } catch {
    return null;
  }
}

/** The communicator instance listeners attach to; changes across reconnects. */
export function audioMonitorCommunicator(): any {
  return activeCommunicator();
}

/**
 * True while Faceclaw itself is forwarding glasses audio to one of its apps
 * (stock mic enable or CFW mic_control forwarding). Packets can also arrive
 * with this false, e.g. when capture was armed and Faceclaw's side stopped.
 */
export function isFaceclawAudioCaptureActive(): boolean {
  try {
    return Boolean(activeCommunicator()?.isAudioCaptureActive());
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
  communicator: any,
  onPacket: (data: Uint8Array, arm: AudioArm, arrivalMs: number) => void,
  onStatus: (body: Uint8Array, arm: AudioArm) => void,
): () => void {
  if (!communicator) return () => {};
  const packetProxy = new com.faceclaw.app.FaceclawAudioPacketListener({
    onAudioPacket: (data: any, arm: string, arrivalMs: number) => {
      onPacket(toUint8Array(data), toArm(arm), Number(arrivalMs));
    },
  });
  const statusProxy = new com.faceclaw.app.FaceclawMicStatusListener({
    onMicStatus: (body: any, arm: string) => {
      onStatus(toUint8Array(body), toArm(arm));
    },
  });
  communicator.addAudioMonitorListener(packetProxy);
  communicator.addMicStatusListener(statusProxy);
  return () => {
    try {
      communicator.removeAudioMonitorListener(packetProxy);
      communicator.removeMicStatusListener(statusProxy);
    } catch {
      // The communicator may have been torn down during a disconnect.
    }
  };
}

function toArm(arm: string): AudioArm {
  const value = String(arm);
  return value === "L" || value === "R" ? value : "?";
}
