/**
 * Which day an event is listed under, and how a multi-day span reads. Pure (no
 * native or UI imports) so it can be unit-tested.
 */
import { MONTH_ABBREVIATIONS, WEEKDAY_ABBREVIATIONS } from "../../util/date-util";

export type DayEvent = { startMs: number; endMs: number; allDay: boolean };

const DAY_MS = 24 * 60 * 60 * 1000;

function midnight(timestampMs: number): number {
  const date = new Date(timestampMs);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Whole calendar days from `fromMs`'s day to `toMs`'s (rounded, so DST days count as one). */
function daysBetween(fromMs: number, toMs: number): number {
  return Math.round((midnight(toMs) - midnight(fromMs)) / DAY_MS);
}

/**
 * The last moment the event covers. Ends are exclusive: an all-day event ends
 * at the midnight after its last day, and a timed one ending at midnight
 * doesn't reach into the next day.
 */
function lastMomentMs(event: DayEvent): number {
  return Math.max(event.startMs, event.endMs - 1);
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
  const day = (date: Date) => `${WEEKDAY_ABBREVIATIONS[date.getDay()]} ${date.getDate()}`;
  return start.getMonth() === last.getMonth() && start.getFullYear() === last.getFullYear()
    ? `${day(start)} – ${day(last)} ${MONTH_ABBREVIATIONS[last.getMonth()]}`
    : `${day(start)} ${MONTH_ABBREVIATIONS[start.getMonth()]} – ${day(last)} ${MONTH_ABBREVIATIONS[last.getMonth()]}`;
}

/**
 * When a timed event ends, read from the day of `fromMs`: the time alone when
 * it ends that day ("02:00"; midnight at the end of the day counts), with its
 * weekday when it ends within the following week ("Fri 17:00"), else with its
 * date ("27 Nov 17:00").
 */
export function endTimeLabel(event: DayEvent, fromMs: number, formatTime: (timestampMs: number) => string): string {
  const time = formatTime(event.endMs);
  if (midnight(lastMomentMs(event)) <= midnight(fromMs)) return time;
  const end = new Date(event.endMs);
  return daysBetween(fromMs, event.endMs) < 7
    ? `${WEEKDAY_ABBREVIATIONS[end.getDay()]} ${time}`
    : `${end.getDate()} ${MONTH_ABBREVIATIONS[end.getMonth()]} ${time}`;
}

/**
 * The time label for a timed event that began on an earlier day and is listed
 * under today: its start would read as later today ("22:00" for last night's
 * shift), so it says when it ends instead ("Until 02:00", "Until Fri 17:00").
 * Null for every other event, whose start time is the right label.
 */
export function carriedOverLabel(event: DayEvent, nowMs: number, formatTime: (timestampMs: number) => string): string | null {
  if (event.allDay || listingDayMs(event, nowMs) <= midnight(event.startMs)) return null;
  return `Until ${endTimeLabel(event, nowMs, formatTime)}`;
}
