/**
 * A keyboard's touchpad or mouse, as the rest of the keyboard support sees
 * it. Its buttons and wheel become keys ("MouseButton1", "WheelUp"), so
 * they get default meanings and custom keybindings like any key
 * (bindings.ts). Its movement goes nowhere unless something has taken the
 * pointer (the cursor test page): there is no cursor in the main UI.
 * No platform imports: this runs under node in the tests.
 */
import type { HidKeyEvent, HidPointerSample } from "./hid";
import { HID_PAGE_BUTTON } from "./keys";

/** The names a wheel's detents arrive under, as keys. */
export type WheelKey = "WheelUp" | "WheelDown" | "WheelLeft" | "WheelRight";

export type PointerInputHost = {
  /** Button transitions, as HID usages on the Button page. */
  buttons(events: HidKeyEvent[]): void;
  /** One wheel report in a direction, however many detents it claimed. */
  wheel(key: WheelKey): void;
};

export class PointerInput {
  /** The buttons the host has been told are down. */
  private reported = 0;
  /** The buttons actually down, as of the last sample. */
  private held = 0;
  /** Buttons that went down while the pointer was taken: not keys until they have come up. */
  private ignored = 0;
  private grab: ((sample: HidPointerSample) => void) | null = null;

  constructor(private readonly host: PointerInputHost) {}

  /** One report from the pointer (see KeyboardClientEvents.pointer). */
  handle(sample: HidPointerSample): void {
    this.held = sample.buttons;
    if (this.grab) {
      this.grab(sample);
      return;
    }
    this.ignored &= sample.buttons;
    this.report(sample.buttons & ~this.ignored);
    // One step per report: a touchpad's two-finger scroll sends many small
    // ones, and the gesture they turn into is rate-limited downstream.
    if (sample.wheel) this.host.wheel(sample.wheel > 0 ? "WheelUp" : "WheelDown");
    if (sample.pan) this.host.wheel(sample.pan > 0 ? "WheelRight" : "WheelLeft");
  }

  /**
   * Take the pointer: every sample goes to `listener`, movement included,
   * and its buttons and wheel stop acting as keys. Buttons held at that
   * moment are released first, so nothing is left down. Returns a function
   * that gives the pointer back.
   */
  take(listener: (sample: HidPointerSample) => void): () => void {
    this.report(0);
    this.grab = listener;
    return () => {
      if (this.grab !== listener) return;
      this.grab = null;
      // A button still down was pressed for the listener, not as a key: its
      // release is nobody's business either.
      this.ignored = this.held;
    };
  }

  /** The keyboard went away: nothing is held, and nobody is told. */
  reset(): void {
    this.reported = 0;
    this.held = 0;
    this.ignored = 0;
  }

  private report(buttons: number): void {
    const changed = buttons ^ this.reported;
    if (!changed) return;
    const events: HidKeyEvent[] = [];
    for (let bit = 0; bit < 8; bit++) {
      if (changed & (1 << bit)) events.push({ page: HID_PAGE_BUTTON, usage: bit + 1, down: !!(buttons & (1 << bit)) });
    }
    this.reported = buttons;
    this.host.buttons(events);
  }
}
