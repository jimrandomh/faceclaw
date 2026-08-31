/**
 * Where an input came from. The ring and the glasses' arms are the stock
 * sources; "watch" is the Wear OS remote, which components may treat with a
 * richer scheme (see isWatchInput) — the ring's semantics are never changed
 * by it.
 */
export type InputSource = "ring" | "left-arm" | "right-arm" | "watch";

/** Fields shared by every input event, whatever its type. */
export type BaseInputEvent = {
  /**
   * When the event was received from the device (or synthesized), as a
   * Date.now() epoch-ms value. The G2 wire formats carry no device-side
   * clock, so this is phone receive time.
   */
  timestampMs: number;
};

/** The per-type part of InputEvent; makeInputEvent adds the BaseInputEvent fields. */
export type InputEventPayload =
  | { type: "click"; source: InputSource }
  | { type: "double-click"; source: InputSource }
  /** Ring scroll (or a watch crown turn, then tagged source "watch"). */
  | { type: "scroll-up"; source?: InputSource }
  | { type: "scroll-down"; source?: InputSource }
  | { type: "long-press"; source: InputSource }
  | { type: "long-press-release"; source: InputSource }
  /**
   * Spatial (four-way) input, which only a watch can produce: the ring's
   * scroll is a one-dimensional cursor, these are directions. Components with
   * a spatial meaning for them opt in with Layer.acceptsDirectional /
   * ShellWindow.acceptsDirectional and must then handle all four; for the
   * rest, directionalFallback turns up/down into scroll, right into "select"
   * (click) and left into "back" (double-click), so a swipe always does
   * something sensible.
   */
  | { type: "swipe-up"; source: "watch" }
  | { type: "swipe-down"; source: "watch" }
  | { type: "swipe-left"; source: "watch" }
  | { type: "swipe-right"; source: "watch" }
  /**
   * The stock display lifecycle woke while no EvenHub page was running. This
   * is wake-only, unlike a normal double-click (which turns an on screen off).
   */
  | { type: "display-wake" }
  /**
   * The on-glasses "Hey Even" wakeword fired. Delivered on sid 0x07 by the
   * stock firmware regardless of CFW; the CFW additionally suppresses the stock
   * Even AI app so this is ours to handle. Its configured action may be applied
   * while the screen is off, unlike ordinary input events.
   */
  | { type: "wakeword" }
  | { type: "unknown"; kind: string; eventSource: number; eventType: number };

export type InputEvent = BaseInputEvent & InputEventPayload;

/** Stamp an event payload into a full InputEvent, timestamped now. */
export function makeInputEvent(payload: InputEventPayload): InputEvent {
  return { ...payload, timestampMs: Date.now() };
}

/** True for input from the Wear OS remote (any type that carries a source). */
export function isWatchInput(event: InputEvent): boolean {
  return "source" in event && event.source === "watch";
}

export type DirectionalInputEvent = Extract<
  InputEvent,
  { type: "swipe-up" | "swipe-down" | "swipe-left" | "swipe-right" }
>;

export function isDirectionalInput(event: InputEvent): event is DirectionalInputEvent {
  return (
    event.type === "swipe-up" ||
    event.type === "swipe-down" ||
    event.type === "swipe-left" ||
    event.type === "swipe-right"
  );
}

/**
 * The ring-vocabulary equivalent of a directional swipe: up/down scroll,
 * right selects, left backs out.
 */
export function directionalFallback(event: InputEvent): InputEvent {
  const base = { timestampMs: event.timestampMs };
  switch (event.type) {
    case "swipe-up":
      return { ...base, type: "scroll-up" };
    case "swipe-down":
      return { ...base, type: "scroll-down" };
    case "swipe-right":
      return { ...base, type: "click", source: "ring" };
    case "swipe-left":
      return { ...base, type: "double-click", source: "ring" };
    default:
      return event;
  }
}

/**
 * Compact glyphs for the ring gestures, used in on-glasses hint text instead
 * of spelling the gesture out. All codepoints exist in terminus12/16.
 *
 *   click        ● (U+00B7 middle dot)
 *   double-click ●● (twice)
 *   scroll       ▲▼ (U+25B2 / U+25BC)
 *   long-press   - (hyphen-minus)
 */
export const GESTURE_CLICK = "\u25cf";
export const GESTURE_DOUBLE_CLICK = GESTURE_CLICK+GESTURE_CLICK;
export const GESTURE_SCROLL_UP = "▲";
export const GESTURE_SCROLL_DOWN = "▼";
export const GESTURE_SCROLL = "▲▼";
export const GESTURE_LONG_PRESS = "-";

/**
 * Join "glyph action" hint pairs into a single line, e.g.
 *   gestureHints([[GESTURE_CLICK, "save"], [GESTURE_DOUBLE_CLICK, "back"]])
 *   => "● save   ●● back"
 */
export function gestureHints(pairs: Array<[string, string]>): string {
  return pairs.map(([glyph, action]) => `${glyph} ${action}`).join("   ");
}
