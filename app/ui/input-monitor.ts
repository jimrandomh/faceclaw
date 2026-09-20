import type { InputEvent } from "./gestures";

type InputListener = (event: Readonly<InputEvent>, filtered: boolean) => void;
const listeners = new Set<InputListener>();

/** Observe every input before deduplication or wake/menu/app routing. */
export function addInputListener(listener: InputListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyInputListeners(event: InputEvent, filtered = false): void {
  if (!listeners.size) return;
  const snapshot = Object.freeze({ ...event,
    ...(event.ringInput ? { ringInput: Object.freeze({ ...event.ringInput }) } : {}) });
  for (const listener of listeners) {
    try { listener(snapshot, filtered); }
    catch (error) { console.warn("Input observer failed", error); }
  }
}

/** Reproduce G2 2.3.0's receiver filter in the original unsigned ring clock.
 * Press (wire 10) neither filters nor advances the clock; hold-release (8)
 * always passes and advances it. Rejected reports do not extend the window.
 * Backward ticks (including ring restart) use the same uint32 subtraction as
 * stock. Legacy, temple, and watch events have no raw metadata and pass through.
 */
export class RingInputFilter {
  private lastTick = 0;
  reset(): void { this.lastTick = 0; }
  accept(event: InputEvent): boolean {
    const raw = event.ringInput;
    if (!raw) return true;
    if (raw.type !== 8 && raw.type !== 10 && this.lastTick !== 0 &&
        ((raw.tick - this.lastTick) >>> 0) < 100) return false;
    if (raw.type !== 10) this.lastTick = raw.tick;
    return true;
  }
}
const ringFilter = new RingInputFilter();
const decisions = new WeakMap<InputEvent, boolean>();
export function resetRingInputFilter(): void { ringFilter.reset(); }

/** Controllers call before lock/glance handling; Shell also accepts direct
 * synthetic input. Cache by event identity so both stages observe/filter once.
 * Debug capture sees even rejected events, without sending them to other apps.
 */
export function acceptInput(event: InputEvent): boolean {
  const previous = decisions.get(event);
  if (previous !== undefined) return previous;
  const timingAccepted = ringFilter.accept(event);
  const accepted = timingAccepted && !(event.ringInput && event.type === "unknown");
  decisions.set(event, accepted);
  notifyInputListeners(event, !timingAccepted);
  return accepted;
}

export type InputLogEntry = {
  event: Readonly<InputEvent>;
  gapMs: number | null;
  ringGapTicks: number | null;
  filtered: boolean;
};

/** A bounded arrival-ordered history; equal timestamps must keep both events. */
export class InputEventLog {
  readonly entries: InputLogEntry[] = [];
  paused = false;
  count = 0;
  private previousMs: number | null = null;
  private previousRingTick: number | null = null;

  add(event: Readonly<InputEvent>, filtered = false): void {
    if (this.paused) return;
    this.entries.unshift({
      event: { ...event, ...(event.ringInput ? { ringInput: { ...event.ringInput } } : {}) },
      filtered,
      ringGapTicks: !event.ringInput || this.previousRingTick === null ? null :
        (event.ringInput.tick - this.previousRingTick) >>> 0,
      gapMs: this.previousMs === null ? null : event.timestampMs - this.previousMs,
    });
    this.previousMs = event.timestampMs;
    if (event.ringInput) this.previousRingTick = event.ringInput.tick;
    this.count++;
    if (this.entries.length > 200) this.entries.length = 200;
  }

  clear(): void {
    this.entries.length = 0;
    this.previousMs = null;
    this.previousRingTick = null;
    this.count = 0;
  }
}

export function inputTimestamp(timestampMs: number): string {
  const date = new Date(timestampMs);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}
