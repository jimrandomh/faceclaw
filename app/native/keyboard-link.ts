import { toJavaBytes } from "./cloud-stt";
import { toUint8Array } from "../util/array-util";

declare const com: any;

/**
 * Platform plumbing for the CFW keyboard bridge (app/g2/keyboard/): the running
 * session to send field-130 controls on and to hear field-131 records from.
 * The session is opaque and is a different object after a reconnect.
 */

export function keyboardLinkSession(): unknown {
  if (!global.isAndroid) return null;
  try {
    return com.faceclaw.app.FaceclawBleCommunicator.getActive();
  } catch {
    return null;
  }
}

/** Queue a control record for the right temple; false when the session wasn't ready and nothing was queued. */
export function sendKeyboardControlRecord(session: unknown, record: Uint8Array, label: string): boolean {
  return (session as any).sendFaceclawKeyboardControl(toJavaBytes(record), label) !== false;
}

/** Raw keyboard-bridge records (undecoded, possibly fragments), in arrival order. Returns an unsubscribe function. */
export function addKeyboardEventListener(session: unknown, listener: (body: Uint8Array) => void): () => void {
  const communicator = session as any;
  const proxy = new com.faceclaw.app.FaceclawKeyboardEventListener({
    onKeyboardEvent: (body: any) => listener(toUint8Array(body)),
  });
  communicator.addKeyboardEventListener(proxy);
  return () => {
    try {
      communicator.removeKeyboardEventListener(proxy);
    } catch {
      // The old communicator instance may be gone after a reconnect.
    }
  };
}
