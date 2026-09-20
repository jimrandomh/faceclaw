import type { InputEvent } from "./gestures";

type InputListener = (event: Readonly<InputEvent>) => void;
const listeners = new Set<InputListener>();

/** Observe input before shell routing consumes menu, hold, or back gestures. */
export function addInputListener(listener: InputListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyInputListeners(event: InputEvent): void {
  if (!listeners.size) return;
  const snapshot = Object.freeze({ ...event });
  for (const listener of listeners) {
    try { listener(snapshot); }
    catch (error) { console.warn("Input observer failed", error); }
  }
}

export type InputLogEntry = {
  event: Readonly<InputEvent>;
  gapMs: number | null;
};

/** A bounded arrival-ordered history; equal timestamps must keep both events. */
export class InputEventLog {
  readonly entries: InputLogEntry[] = [];
  paused = false;
  count = 0;
  private previousMs: number | null = null;

  add(event: Readonly<InputEvent>): void {
    if (this.paused) return;
    this.entries.unshift({
      event: { ...event },
      gapMs: this.previousMs === null ? null : event.timestampMs - this.previousMs,
    });
    this.previousMs = event.timestampMs;
    this.count++;
    if (this.entries.length > 200) this.entries.length = 200;
  }

  clear(): void {
    this.entries.length = 0;
    this.previousMs = null;
    this.count = 0;
  }
}

export function inputTimestamp(timestampMs: number): string {
  const date = new Date(timestampMs);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}
