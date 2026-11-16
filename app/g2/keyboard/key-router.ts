/**
 * Where a key from the hardware keyboard goes: to a keybinding being set up,
 * to a gesture it is bound to, to the window with input focus, or to the
 * built-in navigation. The meanings are in bindings.ts; this is the order of
 * asking, and the bookkeeping around it. Shared by the Android and iOS
 * controllers through KeyRouterHost.
 * No platform imports: this runs under node in the tests.
 */
import {
  GestureScheme,
  chordOf,
  isModifierCode,
  resolveKey,
  type GestureOrigin,
  type KeyAction,
  type KeyChord,
  type KeyGesture,
} from "./bindings";
import type { KeyEvent } from "./keys";

export type KeyRouterHost = {
  /** Connected to glasses that are in use. */
  ready(): boolean;
  locked(): boolean;
  screenOn(): boolean;
  /** Turn a dark display on, and nothing else. */
  wake(): void;
  /** Offer a key to the window with input focus; true when that window takes keys. */
  offerToWindow(event: KeyEvent): boolean;
  /** Perform a gesture as if it came from the ring or the watch. */
  gesture(gesture: KeyGesture, origin: GestureOrigin): Promise<void>;
  /** The custom keybindings, by chord id. */
  bindings(): ReadonlyMap<string, KeyAction>;
  /** A key was used for something other than a gesture or typing (count it against the screen timeout). */
  noteActivity(): void;
  log(line: string): void;
  now?(): number;
};

/**
 * A held key repeats twenty times a second, faster than a list can repaint
 * over the glasses' link. Repeats are dropped while a gesture is still being
 * handled, and closer together than this.
 */
const REPEAT_MIN_INTERVAL_MS = 100;

export class KeyRouter {
  private capture: ((chord: KeyChord) => void) | null = null;
  /** Keys whose press was spoken for, so their release is too. */
  private readonly consumed = new Set<string>();
  private readonly scheme = new GestureScheme();
  private gesturesInFlight = 0;
  private lastGestureAtMs = 0;

  constructor(private readonly host: KeyRouterHost) {}

  /** One key transition from the keyboard. */
  handleKey(event: KeyEvent): void {
    const host = this.host;
    if (!host.ready()) return;
    if (host.locked() || !host.screenOn()) {
      // A dark display takes no typing: the first press only wakes it, as
      // the ring's double tap would, and a locked one stays locked.
      if (event.phase === "down" && !event.repeat && !host.screenOn()) host.wake();
      return;
    }
    if (this.capture) {
      this.captureKey(event);
      return;
    }
    if (event.phase === "up") {
      if (!this.consumed.delete(event.code)) host.offerToWindow(event);
      return;
    }
    const resolution = resolveKey(event, host.bindings());
    if (resolution.consume) {
      this.consumed.add(event.code);
      if (resolution.gesture) this.perform(resolution.gesture, event.repeat);
      return;
    }
    if (host.offerToWindow(event)) return;
    if (resolution.gesture) this.perform(resolution.gesture, event.repeat);
  }

  /**
   * A key the focused window was offered and had no use for (a terminal
   * showing its session list rather than a session): it gets the built-in
   * navigation meaning after all.
   */
  handleUnhandledKey(event: KeyEvent): void {
    const host = this.host;
    if (event.phase !== "down" || this.capture || !host.ready() || host.locked() || !host.screenOn()) return;
    const resolution = resolveKey(event, host.bindings());
    if (!resolution.consume && resolution.gesture) this.perform(resolution.gesture, event.repeat);
  }

  /**
   * Take the next key press instead of acting on it (setting up a
   * keybinding). Modifiers held with it are part of the chord; pressed alone
   * they are waited through. Returns a function that calls the capture off.
   */
  captureNextKey(onChord: (chord: KeyChord) => void): () => void {
    this.capture = onChord;
    return () => {
      if (this.capture === onChord) this.capture = null;
    };
  }

  /** The keyboard went away: nothing is held any more. */
  reset(): void {
    this.consumed.clear();
  }

  private captureKey(event: KeyEvent): void {
    this.host.noteActivity();
    if (event.phase === "up") {
      this.consumed.delete(event.code);
      return;
    }
    if (event.repeat || isModifierCode(event.code)) return;
    const capture = this.capture!;
    this.capture = null;
    this.consumed.add(event.code);
    capture(chordOf(event));
  }

  private perform(gesture: KeyGesture, repeat: boolean): void {
    const now = this.host.now ? this.host.now() : Date.now();
    if (repeat && (this.gesturesInFlight > 0 || now - this.lastGestureAtMs < REPEAT_MIN_INTERVAL_MS)) return;
    this.lastGestureAtMs = now;
    void this.run(gesture, this.scheme.originFor(gesture));
  }

  private async run(gesture: KeyGesture, origin: GestureOrigin): Promise<void> {
    this.gesturesInFlight++;
    try {
      await this.host.gesture(gesture, origin);
    } catch (error) {
      this.host.log(`keyboard gesture ${gesture} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.gesturesInFlight--;
    }
  }
}
