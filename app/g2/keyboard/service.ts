/**
 * The keyboard bridge as the app uses it: one KeyboardBridge for the life of
 * the app, fed by whichever glasses session is live, its remembered keyboard
 * and the custom keybindings kept in the settings store, and its key
 * transitions turned into KeyEvents and routed. The platform's controller
 * reports the link coming and going and performs the gestures keys stand
 * for; the Settings app drives pairing through `bridge` and edits the
 * keybindings.
 */
import { addKeyboardEventListener, keyboardLinkSession, sendKeyboardControlRecord } from "../../native/keyboard-link";
import { getStringSetting, setStringSetting } from "../../native/settings-store";
import { shell } from "../../ui/shell/shell";
import {
  MAX_KEY_BINDINGS,
  chordId,
  keyBindingMap,
  parseKeyBindings,
  serializeKeyBindings,
  type GestureOrigin,
  type KeyAction,
  type KeyBinding,
  type KeyChord,
  type KeyGesture,
} from "./bindings";
import { KeyboardBridge, type KeyboardBridgeSnapshot, type SavedKeyboard } from "./bridge";
import type { HidPointerSample } from "./hid";
import { KeyRouter } from "./key-router";
import { KeyTranslator, type KeyEvent } from "./keys";
import { PointerInput } from "./pointer";

declare const java: any;
declare const arc4random_uniform: ((bound: number) => number) | undefined;

/** JSON of the remembered keyboard ({ address, addressType, name }), or "" for none. */
const SAVED_KEYBOARD_KEY = "keyboard.saved";
/** JSON list of the custom keybindings ({ key, action }); see bindings.ts. */
const KEY_BINDINGS_KEY = "keyboard.bindings";

/** What the platform's controller does for the keyboard. */
export type KeyboardServiceHost = {
  /** Connected to glasses that are in use (not charging in their case). */
  ready(): boolean;
  locked(): boolean;
  /** Turn a dark display on, and nothing else (a locked display stays locked). */
  wake(): void;
  /** Perform a gesture as if it came from the ring or the watch. */
  gesture(gesture: KeyGesture, origin: GestureOrigin): Promise<void>;
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
  private bindings: KeyBinding[] = parseKeyBindings(getStringSetting(KEY_BINDINGS_KEY, ""));
  private bindingMap = keyBindingMap(this.bindings);

  private readonly router = new KeyRouter({
    ready: () => this.host?.ready() ?? false,
    locked: () => this.host?.locked() ?? false,
    screenOn: () => shell.isScreenOn(),
    wake: () => this.host?.wake(),
    offerToWindow: (event) => shell.receiveKeyEvent(event),
    gesture: (gesture, origin) => this.host?.gesture(gesture, origin) ?? Promise.resolve(),
    bindings: () => this.bindingMap,
    noteActivity: () => shell.noteUserActivity(),
    log: (line) => console.log(`[keyboard] ${line}`),
  });
  private readonly translator = new KeyTranslator({ emit: (event) => this.router.handleKey(event) });
  /** The touchpad's buttons and wheel go in as keys; see pointer.ts. */
  private readonly pointer = new PointerInput({
    buttons: (events) => this.translator.handle(events),
    wheel: (key) => this.translator.pulse(key),
  });

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
    onPointer: (sample) => this.pointer.handle(sample),
    onKeyboardGone: () => {
      this.translator.reset();
      this.pointer.reset();
      this.router.reset();
    },
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

  /** A key a worker's window was sent and had no use for (the "key-unhandled" reply). */
  handleUnhandledKey(event: KeyEvent): void {
    this.router.handleUnhandledKey(event);
  }

  // ---------- Custom keybindings ----------

  /** The custom keybindings, in the order they were added. */
  keyBindings(): readonly KeyBinding[] {
    return this.bindings;
  }

  /** Bind a chord, replacing what it was bound to. False when the list is full. */
  setKeyBinding(chord: KeyChord, action: KeyAction): boolean {
    const id = chordId(chord);
    const index = this.bindings.findIndex((binding) => chordId(binding.chord) === id);
    if (index < 0 && this.bindings.length >= MAX_KEY_BINDINGS) return false;
    const next = [...this.bindings];
    if (index < 0) next.push({ chord, action });
    else next[index] = { chord, action };
    this.storeBindings(next);
    return true;
  }

  removeKeyBinding(chord: KeyChord): void {
    const id = chordId(chord);
    this.storeBindings(this.bindings.filter((binding) => chordId(binding.chord) !== id));
  }

  /**
   * Take the next key pressed on the keyboard instead of acting on it. Returns
   * a function that calls the capture off.
   */
  captureNextKey(onChord: (chord: KeyChord) => void): () => void {
    return this.router.captureNextKey(onChord);
  }

  /**
   * Take the keyboard's touchpad or mouse: every report goes to `listener`,
   * movement included, and its buttons and wheel stop acting as keys until
   * the returned function is called. For the cursor test page; the main UI
   * has no cursor.
   */
  takePointer(listener: (sample: HidPointerSample) => void): () => void {
    return this.pointer.take(listener);
  }

  private storeBindings(bindings: KeyBinding[]): void {
    this.bindings = bindings;
    this.bindingMap = keyBindingMap(bindings);
    setStringSetting(KEY_BINDINGS_KEY, serializeKeyBindings(bindings));
  }
}

export const keyboardService = new KeyboardService();
