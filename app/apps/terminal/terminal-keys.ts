/**
 * What a terminal emulator sends for a key from a hardware keyboard, by the
 * classic xterm conventions: Ctrl chords become control characters, Alt
 * prefixes ESC, and modified cursor and function keys carry the xterm
 * modifier parameter (1 + shift + 2*alt + 4*ctrl). Follows the Glassly
 * Terminal miniapp's encoder (terminal/keys.ts, MIT).
 * No platform imports: this runs under node in the tests.
 */
import type { KeyEvent } from "../../g2/keyboard/keys";

const ESC = "\x1b";

/** Keys xterm encodes as `ESC [ <n> ~`, with a modifier as `;m`. */
const TILDE_KEYS: Record<string, number> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24,
};

/** Keys with a single-letter final byte: SS3 in application cursor mode, CSI otherwise. */
const LETTER_KEYS: Record<string, string> = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
  Home: "H",
  End: "F",
};

/** F1-F4 are always SS3 (`ESC O P`), or CSI with a modifier. */
const SS3_KEYS: Record<string, string> = { F1: "P", F2: "Q", F3: "R", F4: "S" };

/** Ctrl with a punctuation or digit key, per xterm (^[ ^\ ^] ^^ ^_ ^? ^@). */
const CONTROL_PUNCTUATION: Record<string, string> = {
  "[": "\x1b",
  "\\": "\x1c",
  "]": "\x1d",
  "^": "\x1e",
  "6": "\x1e",
  "_": "\x1f",
  "-": "\x1f",
  "?": "\x7f",
  "/": "\x7f",
  "8": "\x7f",
  "@": "\x00",
  "2": "\x00",
};

/**
 * The text to write to the terminal for one key event, or null when the key
 * sends nothing: releases, bare modifiers, Meta chords, and keys a terminal
 * has no bytes for (volume, media). `appCursor` is DECCKM, which the emulator
 * tracks from the session's output.
 */
export function encodeTerminalKey(event: KeyEvent, appCursor: boolean): string | null {
  if (event.phase !== "down") return null;
  const { key, modifiers } = event;
  if (modifiers.meta) return null;
  const modifierParam = 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
  const modified = (prefix: string, final: string): string | null =>
    modifierParam > 1 ? `${ESC}[${prefix};${modifierParam}${final}` : null;

  switch (key) {
    case "Enter":
      return modifiers.alt ? `${ESC}\r` : "\r";
    case "Escape":
      return ESC;
    case "Tab":
      return modifiers.shift ? `${ESC}[Z` : "\t";
    case "Backspace":
      if (modifiers.alt) return `${ESC}\x7f`;
      return modifiers.ctrl ? "\x08" : "\x7f";
    case " ":
      return modifiers.ctrl ? "\x00" : modifiers.alt ? `${ESC} ` : " ";
  }

  const letter = LETTER_KEYS[key];
  if (letter) return modified("1", letter) ?? (appCursor ? `${ESC}O${letter}` : `${ESC}[${letter}`);
  const tilde = TILDE_KEYS[key];
  if (tilde) return modified(String(tilde), "~") ?? `${ESC}[${tilde}~`;
  const ss3 = SS3_KEYS[key];
  if (ss3) return modified("1", ss3) ?? `${ESC}O${ss3}`;

  if (modifiers.ctrl) {
    // From the unshifted key: ^A..^Z, then the punctuation set.
    const base = key.length === 1 ? key.toLowerCase() : "";
    let char: string | undefined;
    if (base >= "a" && base <= "z") char = String.fromCharCode(base.charCodeAt(0) - 96);
    else char = CONTROL_PUNCTUATION[key];
    if (char === undefined) return null;
    return modifiers.alt ? `${ESC}${char}` : char;
  }

  // With Alt held the translator leaves `text` out (it is a chord, not
  // typing); a terminal still wants ESC and the character.
  const text = event.text ?? (modifiers.alt && key.length === 1 ? key : undefined);
  if (text === undefined) return null;
  return modifiers.alt ? `${ESC}${text}` : text;
}

/** Shift+PageUp / Shift+PageDown page the emulator's own scrollback, as in xterm. */
export function terminalScrollbackKey(event: KeyEvent): -1 | 1 | null {
  if (event.phase !== "down") return null;
  const { shift, ctrl, alt, meta } = event.modifiers;
  if (!shift || ctrl || alt || meta) return null;
  if (event.key === "PageUp") return -1;
  if (event.key === "PageDown") return 1;
  return null;
}
