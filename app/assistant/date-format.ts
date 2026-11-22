/**
 * Date and calendar-event text for the assistant's tool results and per-turn
 * context. Pure (no native or settings imports) so it can be unit-tested; times
 * follow the wearer's 12/24-hour setting, which callers pass as `twelveHour`.
 */
import { formatHourMinute, MONTH_ABBREVIATIONS, WEEKDAY_ABBREVIATIONS } from "../util/date-util";

export type FormattableEvent = {
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  location?: string;
};

export function formatEvent(event: FormattableEvent, twelveHour: boolean): string {
  const location = event.location ? ` @ ${event.location}` : "";
  return `- ${event.title || "(untitled)"} — ${formatEventSpan(event, twelveHour)}${location}`;
}

/**
 * When an event happens, end included: a multi-day all-day event names its last
 * day (all-day ends are exclusive, at the midnight after it), a timed event its
 * end time. Without the end, an event that started yesterday and runs through
 * tomorrow reads as yesterday's.
 */
export function formatEventSpan(event: Pick<FormattableEvent, "startMs" | "endMs" | "allDay">, twelveHour: boolean): string {
  const start = new Date(event.startMs);
  if (event.allDay) {
    const lastDay = new Date(Math.max(event.startMs, event.endMs - 1));
    return sameDay(start, lastDay)
      ? `${formatDate(start)} (all day)`
      : `${formatDate(start)} – ${formatDate(lastDay)} (all day)`;
  }
  if (!(event.endMs > event.startMs)) return formatDateTime(start, twelveHour);
  const end = new Date(event.endMs);
  return sameDay(start, end)
    ? `${formatDateTime(start, twelveHour)} – ${formatHourMinute(end, twelveHour)}`
    : `${formatDateTime(start, twelveHour)} – ${formatDateTime(end, twelveHour)}`;
}

/** "Thu Nov 19, 9:00 AM", or "Thu Nov 19, 09:00" on a 24-hour clock. */
export function formatDateTime(date: Date, twelveHour: boolean): string {
  return `${formatDate(date)}, ${formatHourMinute(date, twelveHour)}`;
}

export function formatDate(date: Date): string {
  return `${WEEKDAY_ABBREVIATIONS[date.getDay()]} ${MONTH_ABBREVIATIONS[date.getMonth()]} ${date.getDate()}`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
