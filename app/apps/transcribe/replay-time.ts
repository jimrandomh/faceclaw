/** A position in a recording as m:ss, or h:mm:ss from an hour on (or when `withHours`). */
export function formatReplayTime(ms: number, withHours = false): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  if (hours === 0 && !withHours) return `${minutes}:${seconds}`;
  return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
}

/** The time picker's fields, in display and click order. */
export const TIME_FIELDS = ["hours", "minutes", "seconds"] as const;
export type TimeField = (typeof TIME_FIELDS)[number];

const FIELD_SECONDS: Record<TimeField, number> = { hours: 3600, minutes: 60, seconds: 1 };

/**
 * Step a position (whole seconds) by `delta` of a field's unit, carrying
 * into the neighboring fields, within [0, maxSeconds].
 */
export function stepReplaySeconds(seconds: number, field: TimeField, delta: number, maxSeconds: number): number {
  return Math.max(0, Math.min(maxSeconds, seconds + delta * FIELD_SECONDS[field]));
}
