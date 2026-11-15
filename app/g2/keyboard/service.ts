/**
 * The keyboard bridge as the app uses it: one KeyboardBridge for the life of
 * the app, fed by whichever glasses session is live, its remembered keyboard
 * kept in the settings store, and its key transitions turned into KeyEvents.
 * The dashboard controller reports the link coming and going and takes the
 * keys; the Settings app drives pairing through `bridge`.
 */
import { addKeyboardEventListener, keyboardLinkSession, sendKeyboardControlRecord } from "../../native/keyboard-link";
import { getStringSetting, setStringSetting } from "../../native/settings-store";
import { KeyboardBridge, type KeyboardBridgeSnapshot, type SavedKeyboard } from "./bridge";
import { KeyTranslator, type KeyEvent } from "./keys";

declare const java: any;
declare const arc4random_uniform: ((bound: number) => number) | undefined;

/** JSON of the remembered keyboard ({ address, addressType, name }), or "" for none. */
const SAVED_KEYBOARD_KEY = "keyboard.saved";

export type KeyboardServiceHost = {
  onKey(event: KeyEvent): void;
  /** Routine lines only (failed background reconnects); the rest go to the device log directly. */
  log(line: string): void;
  /** Whether an absent keyboard is worth looking for now (see KeyboardBridgeHost). */
  shouldReconnect(): boolean;
};

function loadSavedKeyboard(): SavedKeyboard | null {
  try {
    const raw = getStringSetting(SAVED_KEYBOARD_KEY, "");
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (typeof value?.address !== "string" || typeof value?.addressType !== "number") return null;
    return { address: value.address, addressType: value.addressType, name: typeof value.name === "string" ? value.name : "" };
  } catch {
    return null;
  }
}

/** Passkey entry only protects the pairing if the passkey can't be guessed. */
function randomPasskey(): number {
  try {
    if (global.isAndroid) return new java.security.SecureRandom().nextInt(1_000_000);
    if (typeof arc4random_uniform === "function") return arc4random_uniform(1_000_000);
  } catch {
    // Fall through to the weaker source rather than failing the pairing.
  }
  return Math.floor(Math.random() * 1_000_000);
}

class KeyboardService {
  private host: KeyboardServiceHost | null = null;
  private session: unknown = null;
  private offEvents: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly translator = new KeyTranslator({ emit: (event) => this.host?.onKey(event) });

  readonly bridge = new KeyboardBridge({
    send: (record) => {
      const session = this.session;
      if (!session) return false;
      try {
        return sendKeyboardControlRecord(session, record, `op=${record[3]}`);
      } catch {
        return false;
      }
    },
    loadSaved: loadSavedKeyboard,
    storeSaved: (saved) => setStringSetting(SAVED_KEYBOARD_KEY, saved ? JSON.stringify(saved) : ""),
    onKeys: (events) => this.translator.handle(events),
    onKeyboardGone: () => this.translator.reset(),
    onChanged: () => {
      for (const listener of [...this.listeners]) listener();
    },
    // Pairing and setup are rare and are what a failure report needs, so
    // they always reach the device log. Nothing here ever includes a key.
    log: (line, routine) => {
      if (routine) this.host?.log(line);
      else console.log(`[keyboard] ${line}`);
    },
    randomPasskey,
    shouldReconnect: () => this.host?.shouldReconnect() ?? true,
  });

  setHost(host: KeyboardServiceHost): void {
    this.host = host;
  }

  snapshot(): KeyboardBridgeSnapshot {
    return this.bridge.snapshot();
  }

  /** Called on every bridge state change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The glasses came into use (the display woke): look for an absent keyboard now. */
  retryNow(): void {
    this.bridge.retryNow();
  }

  /** A G2 session on firmware with the bridge is up. Idempotent. */
  linkReady(): void {
    const session = keyboardLinkSession();
    if (!session) return;
    if (session !== this.session) {
      // The native session object is rebuilt across reconnects.
      this.offEvents?.();
      this.session = session;
      this.offEvents = addKeyboardEventListener(session, (body) => this.bridge.accept(body));
    }
    this.bridge.linkReady();
  }

  /**
   * The session can't host the keyboard any more. `release` asks the firmware
   * to let the keyboard go first, for when the link itself stays up (the
   * glasses went into their case, or the app is disconnecting on purpose).
   * Idempotent.
   */
  linkLost(release = false): void {
    if (release) this.bridge.linkClosing();
    this.bridge.linkLost();
    this.offEvents?.();
    this.offEvents = null;
    this.session = null;
  }
}

export const keyboardService = new KeyboardService();
