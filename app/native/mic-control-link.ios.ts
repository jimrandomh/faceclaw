import { FaceclawCommunicatorBridge } from "./faceclaw-communicator.ios";

/** The iOS twin of mic-control-link.ts, over the running shared-Kotlin session. */

export function micControlSession(): unknown {
  return FaceclawCommunicatorBridge.getActive();
}

/** Queue a record for the chosen temples; false when the session wasn't ready and nothing was queued. */
export function sendMicControlRecord(
  session: unknown,
  record: Uint8Array,
  label: string,
  rightTemple: boolean,
  leftTemple: boolean,
): boolean {
  return (session as FaceclawCommunicatorBridge).sendFaceclawMicControl(record, label, rightTemple, leftTemple);
}

/** Status record bodies (undecoded) and their temple: "L", "R" or "?". Returns an unsubscribe function. */
export function addMicStatusListener(session: unknown, listener: (body: Uint8Array, arm: string) => void): () => void {
  const unsubscribe = (session as FaceclawCommunicatorBridge).addMicStatusListener(listener);
  return () => {
    try {
      unsubscribe();
    } catch {
      // The session may have been closed during a reconnect.
    }
  };
}
