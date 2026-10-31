import { toJavaBytes } from "./cloud-stt";
import { toUint8Array } from "../util/array-util";

declare const com: any;

/**
 * Platform plumbing for the CFW mic_control channel (apps/microphones/mic-control.ts):
 * the running session to send records on and to hear field-104 status replies
 * from. The session is opaque and is a different object after a reconnect.
 */

export function micControlSession(): unknown {
  if (!global.isAndroid) return null;
  try {
    return com.faceclaw.app.FaceclawBleCommunicator.getActive();
  } catch {
    return null;
  }
}

/** Queue a record for the chosen temples; false when the session wasn't ready and nothing was queued. */
export function sendMicControlRecord(
  session: unknown,
  record: Uint8Array,
  label: string,
  rightTemple: boolean,
  leftTemple: boolean,
): boolean {
  return (session as any).sendFaceclawMicControl(toJavaBytes(record), label, rightTemple, leftTemple) !== false;
}

/** Status record bodies (undecoded) and their temple: "L", "R" or "?". Returns an unsubscribe function. */
export function addMicStatusListener(session: unknown, listener: (body: Uint8Array, arm: string) => void): () => void {
  const communicator = session as any;
  const proxy = new com.faceclaw.app.FaceclawMicStatusListener({
    onMicStatus: (body: any, arm: string) => listener(toUint8Array(body), String(arm)),
  });
  communicator.addMicStatusListener(proxy);
  return () => {
    try {
      communicator.removeMicStatusListener(proxy);
    } catch {
      // The old communicator instance may be gone after a reconnect.
    }
  };
}
