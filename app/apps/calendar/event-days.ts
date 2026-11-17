/**
 * Which day an event is listed under, and how a multi-day span reads. Pure (no
 * native or UI imports) so it can be unit-tested.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type DayEvent = { startMs: number; endMs: number; allDay: boolean };

function midnight(timestampMs: number): number {
  const date = new Date(timestampMs);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The last moment the event covers: all-day ends are exclusive (the midnight after its last day). */
function lastMomentMs(event: DayEvent): number {
  return event.allDay ? Math.max(event.startMs, event.endMs - 1) : Math.max(event.startMs, event.endMs);
}

/**
 * The day to list an event under: its start, or today for one that began on an
 * earlier day and is still going. Without this, the third day of a three-day
 * event shows under its first day and never under today.
 */
export function listingDayMs(event: DayEvent, nowMs: number): number {
  return Math.max(midnight(event.startMs), Math.min(midnight(nowMs), midnight(lastMomentMs(event))));
}

/** Whether the event covers more than one calendar day. */
export function spansDays(event: DayEvent): boolean {
  return midnight(lastMomentMs(event)) > midnight(event.startMs);
}

/** "Mon 16 – Wed 18 Nov", or with both months when they differ ("Mon 30 Nov – Tue 1 Dec"). */
export function spanLabel(event: DayEvent): string {
  const start = new Date(event.startMs);
  const last = new Date(lastMomentMs(event));
  const day = (date: Date) => `${WEEKDAYS[date.getDay()]} ${date.getDate()}`;
  return start.getMonth() === last.getMonth() && start.getFullYear() === last.getFullYear()
    ? `${day(start)} – ${day(last)} ${MONTHS[last.getMonth()]}`
    : `${day(start)} ${MONTHS[start.getMonth()]} – ${day(last)} ${MONTHS[last.getMonth()]}`;
}
