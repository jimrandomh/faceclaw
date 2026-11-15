/**
 * Key events as the rest of Faceclaw sees them, and the translation from the
 * keyboard bridge's raw HID transitions: layout (US only for now), modifier
 * and Caps Lock state, and typematic repeat, which a BLE keyboard never sends
 * (its report just stays asserted). The translation tables follow the Glassly
 * app's (GlassesKeyboardInput.ts, MIT).
 * No platform imports: this runs under node in the tests, and in app workers.
 */
import type { HidKeyEvent } from "./hid";

export type KeyModifiers = { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean };

/**
 * One key transition, shaped like a DOM KeyboardEvent: `key` is the logical
 * key with the layout applied ("a", "A", "Enter", "ArrowUp"), `code` the
 * physical key ("KeyA"), `text` what a press types (absent for releases, for
 * keys that type nothing, and for Ctrl/Alt/Meta chords, which are commands).
 */
export type KeyEvent = {
  phase: "down" | "up";
  key: string;
  code: string;
  text?: string;
  modifiers: KeyModifiers;
  /** A synthesized auto-repeat of a held key. */
  repeat: boolean;
  /** Date.now() when the phone saw the transition. */
  timestampMs: number;
};

const HID_PAGE_KEYBOARD = 7;
const HID_PAGE_CONSUMER = 12;
const USAGE_CAPS_LOCK = 57;

/** [unshifted, shifted, code] for US-layout punctuation on the keyboard page. */
const PUNCTUATION: Record<number, [string, string, string]> = {
  45: ["-", "_", "Minus"],
  46: ["=", "+", "Equal"],
  47: ["[", "{", "BracketLeft"],
  48: ["]", "}", "BracketRight"],
  49: ["\\", "|", "Backslash"],
  50: ["#", "~", "IntlHash"],
  51: [";", ":", "Semicolon"],
  52: ["'", '"', "Quote"],
  53: ["`", "~", "Backquote"],
  54: [",", "<", "Comma"],
  55: [".", ">", "Period"],
  56: ["/", "?", "Slash"],
  100: ["\\", "|", "IntlBackslash"],
};

const DIGITS = "1234567890";
const SHIFTED_DIGITS = "!@#$%^&*()";

/** [key, code] for keys that type nothing. */
const NAMED: Record<number, [string, string]> = {
  40: ["Enter", "Enter"],
  41: ["Escape", "Escape"],
  42: ["Backspace", "Backspace"],
  43: ["Tab", "Tab"],
  57: ["CapsLock", "CapsLock"],
  70: ["PrintScreen", "PrintScreen"],
  71: ["ScrollLock", "ScrollLock"],
  72: ["Pause", "Pause"],
  73: ["Insert", "Insert"],
  74: ["Home", "Home"],
  75: ["PageUp", "PageUp"],
  76: ["Delete", "Delete"],
  77: ["End", "End"],
  78: ["PageDown", "PageDown"],
  79: ["ArrowRight", "ArrowRight"],
  80: ["ArrowLeft", "ArrowLeft"],
  81: ["ArrowDown", "ArrowDown"],
  82: ["ArrowUp", "ArrowUp"],
  83: ["NumLock", "NumLock"],
  88: ["Enter", "NumpadEnter"],
  101: ["ContextMenu", "ContextMenu"],
  102: ["Power", "Power"],
  224: ["Control", "ControlLeft"],
  225: ["Shift", "ShiftLeft"],
  226: ["Alt", "AltLeft"],
  227: ["Meta", "MetaLeft"],
  228: ["Control", "ControlRight"],
  229: ["Shift", "ShiftRight"],
  230: ["Alt", "AltRight"],
  231: ["Meta", "MetaRight"],
};

/** [key and text, code] for the numeric keypad's operators. */
const NUMPAD: Record<number, [string, string]> = {
  84: ["/", "NumpadDivide"],
  85: ["*", "NumpadMultiply"],
  86: ["-", "NumpadSubtract"],
  87: ["+", "NumpadAdd"],
  99: [".", "NumpadDecimal"],
  103: ["=", "NumpadEqual"],
};

const CONSUMER: Record<number, string> = {
  0xe9: "AudioVolumeUp",
  0xea: "AudioVolumeDown",
  0xe2: "AudioVolumeMute",
  0xcd: "MediaPlayPause",
  0xb0: "MediaPlay",
  0xb1: "MediaPause",
  0xb5: "MediaTrackNext",
  0xb6: "MediaTrackPrevious",
  0xb7: "MediaStop",
  0x6f: "BrightnessUp",
  0x70: "BrightnessDown",
  0x221: "BrowserSearch",
  0x223: "BrowserHome",
  0x224: "BrowserBack",
  0x225: "BrowserForward",
  0x18a: "LaunchMail",
  0x192: "LaunchApplication2",
  0x194: "LaunchApplication1",
};

const MODIFIER_USAGES: Record<number, keyof KeyModifiers> = {
  224: "ctrl", 228: "ctrl", 225: "shift", 229: "shift", 226: "alt", 230: "alt", 227: "meta", 231: "meta",
};

type Translated = { key: string; code: string; text?: string };

/** One HID usage under the US layout. Caps Lock only affects letters. */
export function translateUsage(page: number, usage: number, shift: boolean, capsLock: boolean): Translated {
  if (page === HID_PAGE_KEYBOARD) {
    if (usage >= 4 && usage <= 29) {
      const lower = String.fromCharCode(97 + usage - 4);
      const key = shift !== capsLock ? lower.toUpperCase() : lower;
      return { key, code: `Key${lower.toUpperCase()}`, text: key };
    }
    if (usage >= 30 && usage <= 39) {
      const index = usage - 30;
      const key = shift ? SHIFTED_DIGITS[index]! : DIGITS[index]!;
      return { key, code: `Digit${DIGITS[index]}`, text: key };
    }
    if (usage === 44) return { key: " ", code: "Space", text: " " };
    const punctuation = PUNCTUATION[usage];
    if (punctuation) {
      const key = shift ? punctuation[1] : punctuation[0];
      return { key, code: punctuation[2], text: key };
    }
    if (usage >= 58 && usage <= 69) return { key: `F${usage - 57}`, code: `F${usage - 57}` };
    if (usage >= 104 && usage <= 115) return { key: `F${usage - 91}`, code: `F${usage - 91}` };
    if (usage >= 89 && usage <= 97) {
      const digit = String(usage - 88);
      return { key: digit, code: `Numpad${digit}`, text: digit };
    }
    if (usage === 98) return { key: "0", code: "Numpad0", text: "0" };
    const numpad = NUMPAD[usage];
    if (numpad) return { key: numpad[0], code: numpad[1], text: numpad[0] };
    const named = NAMED[usage];
    if (named) return { key: named[0], code: named[1] };
    return { key: "Unidentified", code: `Usage${usage.toString(16).padStart(2, "0")}` };
  }
  if (page === HID_PAGE_CONSUMER) {
    const name = CONSUMER[usage];
    return name ? { key: name, code: name } : { key: "Unidentified", code: `Consumer${usage.toString(16)}` };
  }
  return { key: "Unidentified", code: `Page${page.toString(16)}Usage${usage.toString(16)}` };
}

export type KeyTranslatorOptions = {
  emit: (event: KeyEvent) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Hold time before the first repeat, and the gap between repeats. */
  repeatDelayMs?: number;
  repeatIntervalMs?: number;
};

const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 50;

/**
 * Raw HID transitions in, KeyEvents out. Modifier state comes from the same
 * stream, and the bridge reports a release for every key when the stream may
 * have lost something, so a missed key-up cannot leave a modifier stuck or a
 * key repeating forever.
 */
export class KeyTranslator {
  private readonly emitEvent: (event: KeyEvent) => void;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly repeatDelayMs: number;
  private readonly repeatIntervalMs: number;
  private readonly held = new Set<string>();
  private modifiers: KeyModifiers = { shift: false, ctrl: false, alt: false, meta: false };
  private capsLock = false;
  private repeatTimer: unknown = null;
  private repeating: { page: number; usage: number } | null = null;

  constructor(options: KeyTranslatorOptions) {
    this.emitEvent = options.emit;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.repeatDelayMs = options.repeatDelayMs ?? REPEAT_DELAY_MS;
    this.repeatIntervalMs = options.repeatIntervalMs ?? REPEAT_INTERVAL_MS;
  }

  /** Apply the transitions one input report produced, in order. */
  handle(events: readonly HidKeyEvent[]): void {
    for (const event of events) this.handleOne(event);
  }

  private handleOne(event: HidKeyEvent): void {
    const id = `${event.page}:${event.usage}`;
    const modifier = event.page === HID_PAGE_KEYBOARD ? MODIFIER_USAGES[event.usage] : undefined;
    if (event.down) {
      if (this.held.has(id)) return;
      this.held.add(id);
      if (modifier) this.modifiers[modifier] = true;
      if (event.page === HID_PAGE_KEYBOARD && event.usage === USAGE_CAPS_LOCK) this.capsLock = !this.capsLock;
      this.emit("down", event.page, event.usage, false);
      // The newest non-modifier key is the one that repeats, as on a PC.
      if (!modifier) this.startRepeat(event.page, event.usage);
    } else {
      if (!this.held.delete(id)) return;
      if (modifier) this.modifiers[modifier] = this.otherHeld(event.usage, modifier);
      if (this.repeating?.page === event.page && this.repeating.usage === event.usage) this.stopRepeat();
      this.emit("up", event.page, event.usage, false);
    }
  }

  /** The keyboard went away: forget everything without emitting releases. */
  reset(): void {
    this.stopRepeat();
    this.held.clear();
    this.modifiers = { shift: false, ctrl: false, alt: false, meta: false };
    this.capsLock = false;
  }

  /** Whether the same modifier's key on the other side is still down. */
  private otherHeld(released: number, modifier: keyof KeyModifiers): boolean {
    for (const [usage, name] of Object.entries(MODIFIER_USAGES)) {
      if (name === modifier && Number(usage) !== released && this.held.has(`${HID_PAGE_KEYBOARD}:${usage}`)) return true;
    }
    return false;
  }

  private emit(phase: "down" | "up", page: number, usage: number, repeat: boolean): void {
    const translated = translateUsage(page, usage, this.modifiers.shift, this.capsLock);
    const event: KeyEvent = {
      phase,
      key: translated.key,
      code: translated.code,
      modifiers: { ...this.modifiers },
      repeat,
      timestampMs: this.now(),
    };
    if (phase === "down" && translated.text !== undefined &&
        !this.modifiers.ctrl && !this.modifiers.alt && !this.modifiers.meta) {
      event.text = translated.text;
    }
    this.emitEvent(event);
  }

  private startRepeat(page: number, usage: number): void {
    this.stopRepeat();
    this.repeating = { page, usage };
    this.repeatTimer = this.setTimer(() => this.repeatTick(), this.repeatDelayMs);
  }

  private repeatTick(): void {
    const key = this.repeating;
    this.repeatTimer = null;
    if (!key || !this.held.has(`${key.page}:${key.usage}`)) {
      this.repeating = null;
      return;
    }
    this.emit("down", key.page, key.usage, true);
    this.repeatTimer = this.setTimer(() => this.repeatTick(), this.repeatIntervalMs);
  }

  private stopRepeat(): void {
    if (this.repeatTimer !== null) this.clearTimer(this.repeatTimer);
    this.repeatTimer = null;
    this.repeating = null;
  }
}

/** The ring gestures a keyboard can stand in for. */
export type KeyNavigationGesture = "scroll-up" | "scroll-down" | "click" | "double-click";

/**
 * What a key does where nothing takes keys as keys: the ring's vocabulary,
 * with the same reading of left and right as a watch swipe (right selects,
 * left backs out). Held arrows keep scrolling; Enter and Escape act once per
 * press. Chords and every other key do nothing. This is a deliberately small
 * default, not a button-mapping scheme.
 */
export function navigationGestureForKey(event: KeyEvent): KeyNavigationGesture | null {
  if (event.phase !== "down") return null;
  const { ctrl, alt, meta } = event.modifiers;
  if (ctrl || alt || meta) return null;
  switch (event.key) {
    case "ArrowUp":
      return "scroll-up";
    case "ArrowDown":
      return "scroll-down";
    case "Enter":
    case "ArrowRight":
      return event.repeat ? null : "click";
    case "Escape":
    case "ArrowLeft":
      return event.repeat ? null : "double-click";
    default:
      return null;
  }
}
