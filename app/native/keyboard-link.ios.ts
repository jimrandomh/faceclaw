import { FaceclawCommunicatorBridge } from "./faceclaw-communicator.ios";

/** The iOS twin of keyboard-link.ts, over the running shared-Kotlin session. */

export function keyboardLinkSession(): unknown {
  return FaceclawCommunicatorBridge.getActive();
}

/** Queue a control record for the right temple; false when the session wasn't ready and nothing was queued. */
export function sendKeyboardControlRecord(session: unknown, record: Uint8Array, label: string): boolean {
  return (session as FaceclawCommunicatorBridge).sendFaceclawKeyboardControl(record, label);
}

/** Raw keyboard-bridge records (undecoded, possibly fragments), in arrival order. Returns an unsubscribe function. */
export function addKeyboardEventListener(session: unknown, listener: (body: Uint8Array) => void): () => void {
  const unsubscribe = (session as FaceclawCommunicatorBridge).addKeyboardEventListener(listener);
  return () => {
    try {
      unsubscribe();
    } catch {
      // The session may have been closed during a reconnect.
    }
  };
}
