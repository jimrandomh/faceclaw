/**
 * What keys from a hardware keyboard do, apart from typing: the built-in
 * defaults, the user's custom keybindings, and how the two combine.
 *
 * A key becomes one of the gestures the ring and the watch already have, so
 * nothing downstream knows about keyboards. Three layers, first match wins:
 *
 *  1. Custom keybindings (Settings > Keyboard > Keybindings). These apply
 *     everywhere, including where the focused window takes keys for itself
 *     (a terminal session), since that is the point of binding a remote's
 *     few buttons.
 *  2. Built-in bindings that also apply there: Escape with Shift, Ctrl or
 *     Alt goes back, which is the way out of a terminal session; and a
 *     mouse's buttons and wheel, which are never typed.
 *  3. Built-in navigation, only for keys no window took: the arrows are the
 *     watch's four swipes, Enter selects, Escape goes back.
 *
 * A keyboard's touchpad or mouse arrives here as keys too: "MouseButton1"
 * (left), "MouseButton2" (right), "MouseButton3" (middle) and so on, and
 * "WheelUp" / "WheelDown" / "WheelLeft" / "WheelRight" (see pointer.ts).
 *
 * No platform imports: this runs under node in the tests.
 */
import type { KeyEvent } from "./keys";

/** A gesture a key can stand for, named as the input pipeline names it. */
export type KeyGesture =
  | "swipe-up"
  | "swipe-down"
  | "swipe-left"
  | "swipe-right"
  | "scroll-up"
  | "scroll-down"
  | "click"
  | "double-click"
  | "long-press"
  | "short-then-long-press";

/**
 * What a custom keybinding does. "none" turns off the key's built-in
 * navigation meaning; it does not stop the key being typed into a window
 * that takes keys.
 */
export type KeyAction = KeyGesture | "none";

/** The actions, in the order the picker lists them. */
export const KEY_ACTIONS: readonly { action: KeyAction; label: string }[] = [
  { action: "click", label: "Select" },
  { action: "double-click", label: "Back" },
  { action: "swipe-up", label: "Swipe up" },
  { action: "swipe-down", label: "Swipe down" },
  { action: "swipe-left", label: "Swipe left" },
  { action: "swipe-right", label: "Swipe right" },
  { action: "scroll-up", label: "Scroll up" },
  { action: "scroll-down", label: "Scroll down" },
  { action: "long-press", label: "System menu" },
  { action: "short-then-long-press", label: "App menu" },
  { action: "none", label: "Nothing" },
];

export function keyActionLabel(action: KeyAction): string {
  return KEY_ACTIONS.find((entry) => entry.action === action)?.label ?? action;
}

function isKeyAction(value: unknown): value is KeyAction {
  return KEY_ACTIONS.some((entry) => entry.action === value);
}

/** A physical key with the modifiers held: what a keybinding is keyed on. */
export type KeyChord = { code: string; shift: boolean; ctrl: boolean; alt: boolean; meta: boolean };
export type KeyBinding = { chord: KeyChord; action: KeyAction };

const MODIFIER_CODES = new Set([
  "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight",
]);

/** Shift, Ctrl, Alt and Meta themselves: they qualify a chord rather than being one. */
export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

export function chordOf(event: KeyEvent): KeyChord {
  const { shift, ctrl, alt, meta } = event.modifiers;
  return { code: event.code, shift, ctrl, alt, meta };
}

/** Canonical text of a chord ("Ctrl+Shift+Escape"): the stored form, and the lookup key. */
export function chordId(chord: KeyChord): string {
  return [chord.ctrl && "Ctrl", chord.alt && "Alt", chord.shift && "Shift", chord.meta && "Meta", chord.code]
    .filter(Boolean).join("+");
}

/** The inverse of chordId, or null for anything it could not have produced. */
export function parseChordId(text: string): KeyChord | null {
  const parts = text.split("+");
  const code = parts.pop() ?? "";
  if (!/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(code) || isModifierCode(code)) return null;
  const chord: KeyChord = { code, shift: false, ctrl: false, alt: false, meta: false };
  for (const part of parts) {
    if (part === "Ctrl" && !chord.ctrl) chord.ctrl = true;
    else if (part === "Alt" && !chord.alt) chord.alt = true;
    else if (part === "Shift" && !chord.shift) chord.shift = true;
    else if (part === "Meta" && !chord.meta) chord.meta = true;
    else return null;
  }
  return chord;
}

const CODE_LABELS: Record<string, string> = {
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Escape: "Esc", PageUp: "Page Up", PageDown: "Page Down", CapsLock: "Caps Lock",
  PrintScreen: "Print Screen", ScrollLock: "Scroll Lock", NumLock: "Num Lock", ContextMenu: "Menu",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", IntlBackslash: "\\",
  IntlHash: "#", Semicolon: ";", Quote: "'", Backquote: "`", Comma: ",", Period: ".", Slash: "/",
  AudioVolumeUp: "Volume Up", AudioVolumeDown: "Volume Down", AudioVolumeMute: "Mute",
  MediaPlayPause: "Play/Pause", MediaPlay: "Play", MediaPause: "Pause", MediaStop: "Stop",
  MediaTrackNext: "Next Track", MediaTrackPrevious: "Previous Track",
  BrightnessUp: "Brightness Up", BrightnessDown: "Brightness Down",
  BrowserSearch: "Search", BrowserHome: "Browser Home", BrowserBack: "Browser Back", BrowserForward: "Browser Forward",
  LaunchMail: "Mail", LaunchApplication1: "App 1", LaunchApplication2: "App 2",
  MouseButton1: "Left button", MouseButton2: "Right button", MouseButton3: "Middle button",
  WheelUp: "Wheel up", WheelDown: "Wheel down", WheelLeft: "Wheel left", WheelRight: "Wheel right",
};

/** A key as a person would name it. Unknown keys keep their HID usage number, which is all there is. */
function codeLabel(code: string): string {
  const known = CODE_LABELS[code];
  if (known) return known;
  let match = /^Key([A-Z])$/.exec(code);
  if (match) return match[1]!;
  match = /^Digit([0-9])$/.exec(code);
  if (match) return match[1]!;
  match = /^Numpad(.+)$/.exec(code);
  if (match) return `Numpad ${match[1]}`;
  match = /^MouseButton([0-9]+)$/.exec(code);
  if (match) return `Mouse button ${match[1]}`;
  match = /^Usage([0-9a-f]+)$/.exec(code);
  if (match) return `Key 0x${match[1]}`;
  match = /^Consumer([0-9a-f]+)$/.exec(code);
  if (match) return `Media key 0x${match[1]}`;
  return code;
}

/** A chord for display: "Shift+Esc", "Left", "Volume Up". */
export function describeChord(chord: KeyChord): string {
  return [chord.ctrl && "Ctrl", chord.alt && "Alt", chord.shift && "Shift", chord.meta && "Meta", codeLabel(chord.code)]
    .filter(Boolean).join("+");
}

/** The most custom keybindings kept; far more than a keyboard has uses for. */
export const MAX_KEY_BINDINGS = 64;

/**
 * Custom keybindings from their stored JSON. Lenient: whatever doesn't make
 * sense is dropped, and a later entry for a chord replaces an earlier one.
 */
export function parseKeyBindings(raw: string): KeyBinding[] {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const bindings = new Map<string, KeyBinding>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const { key, action } = entry as { key?: unknown; action?: unknown };
    const chord = typeof key === "string" ? parseChordId(key) : null;
    if (!chord || !isKeyAction(action)) continue;
    bindings.set(chordId(chord), { chord, action });
    if (bindings.size >= MAX_KEY_BINDINGS) break;
  }
  return [...bindings.values()];
}

export function serializeKeyBindings(bindings: readonly KeyBinding[]): string {
  return JSON.stringify(bindings.map((binding) => ({ key: chordId(binding.chord), action: binding.action })));
}

/** Custom keybindings as the lookup resolveKey takes. */
export function keyBindingMap(bindings: readonly KeyBinding[]): Map<string, KeyAction> {
  return new Map(bindings.map((binding) => [chordId(binding.chord), binding.action]));
}

/** What a mouse does unless bound otherwise: the ring's tap, double tap, hold and scroll. */
const MOUSE_DEFAULTS: Record<string, KeyGesture | undefined> = {
  MouseButton1: "click",
  MouseButton2: "double-click",
  MouseButton3: "long-press",
  WheelUp: "scroll-up",
  WheelDown: "scroll-down",
};

/**
 * The built-in meaning of a key press, or null when it has none.
 * `overridesTyping`: it holds even where the focused window takes keys.
 * Built-ins go by the logical key, so both Enter keys select.
 */
export function defaultKeyAction(event: KeyEvent): { action: KeyGesture; overridesTyping: boolean } | null {
  // A mouse's buttons and wheel are the ring's gestures: tap, double tap,
  // hold, and scroll. Nothing types them, so they hold everywhere, whatever
  // is held on the keyboard.
  const mouse = MOUSE_DEFAULTS[event.key];
  if (mouse) return { action: mouse, overridesTyping: true };
  const { shift, ctrl, alt, meta } = event.modifiers;
  if (meta) return null;
  if (event.key === "Escape") {
    // Plain Escape belongs to whatever takes keys (it is a keystroke in a
    // terminal); with a modifier it always means "back out of here".
    return { action: "double-click", overridesTyping: shift || ctrl || alt };
  }
  if (ctrl || alt) return null;
  switch (event.key) {
    case "ArrowUp":
      return { action: "swipe-up", overridesTyping: false };
    case "ArrowDown":
      return { action: "swipe-down", overridesTyping: false };
    case "ArrowLeft":
      return { action: "swipe-left", overridesTyping: false };
    case "ArrowRight":
      return { action: "swipe-right", overridesTyping: false };
    case "Enter":
      return { action: "click", overridesTyping: false };
    default:
      return null;
  }
}

/** The built-ins, for showing to the user. Keep in step with defaultKeyAction. */
export const DEFAULT_KEYS_HELP =
  "Arrow keys: swipe up, down, left and right, as on the watch. Enter: select. Esc: back.\n\n" +
  "In a terminal session those keys are typed instead, and Shift+Esc (or Ctrl+Esc, Alt+Esc) goes back.\n\n" +
  "Mouse or touchpad: the left button selects, the right button goes back, the middle button opens the system menu, " +
  "and the wheel scrolls. These work in a terminal session too.\n\n" +
  "A custom keybinding replaces these for its key and works everywhere, terminals included. " +
  "\"Nothing\" turns a key's meaning here off without stopping it being typed.";

/**
 * Whether holding the key repeats the gesture. Moving up and down a list
 * does. Sideways swipes don't: depending on the layout they enter and leave
 * things, and a held key would flap between the two. Selecting, backing out
 * and menus act once per press.
 */
export function gestureRepeats(gesture: KeyGesture): boolean {
  return gesture === "scroll-up" || gesture === "scroll-down" || gesture === "swipe-up" || gesture === "swipe-down";
}

export type KeyResolution = {
  /** The key is spoken for: don't offer it to the focused window. */
  consume: boolean;
  /**
   * The gesture to perform: at once when `consume`, otherwise only if no
   * window takes the key. Null for none (including a held key's repeats of
   * a gesture that doesn't repeat).
   */
  gesture: KeyGesture | null;
};

/** What one key press (or auto-repeat) means, given the custom keybindings. */
export function resolveKey(event: KeyEvent, custom: ReadonlyMap<string, KeyAction>): KeyResolution {
  const repeatable = (gesture: KeyGesture): KeyGesture | null =>
    event.repeat && !gestureRepeats(gesture) ? null : gesture;
  const bound = custom.get(chordId(chordOf(event)));
  if (bound !== undefined && bound !== "none") return { consume: true, gesture: repeatable(bound) };
  // "none" takes the built-in meaning away and leaves the key to be typed.
  if (bound === "none") return { consume: false, gesture: null };
  const builtIn = defaultKeyAction(event);
  if (!builtIn) return { consume: false, gesture: null };
  return { consume: builtIn.overridesTyping, gesture: repeatable(builtIn.action) };
}

export type GestureOrigin = "ring" | "watch";

/**
 * Which device a keyboard's gesture is presented as. Swipes are the watch's
 * and scrolls the ring's; the two schemes differ in places (an icon grid
 * moves by cell for the watch, by row and then cell for the ring). A tap, a
 * double tap or a hold exists in both, so it goes with whichever the
 * keyboard last moved with: arrow keys make the keyboard a watch, a remote
 * bound to scroll makes it a ring. Before any movement, the watch.
 */
export class GestureScheme {
  private scheme: GestureOrigin = "watch";

  originFor(gesture: KeyGesture): GestureOrigin {
    if (gesture.startsWith("swipe-")) this.scheme = "watch";
    else if (gesture.startsWith("scroll-")) this.scheme = "ring";
    return this.scheme;
  }
}
