/**
 * Date and calendar-event text for the assistant's tool results. Pure (no
 * native imports) so it can be unit-tested.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type FormattableEvent = {
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  location?: string;
};

export function formatEvent(event: FormattableEvent): string {
  const location = event.location ? ` @ ${event.location}` : "";
  return `- ${event.title || "(untitled)"} — ${formatEventSpan(event)}${location}`;
}

/**
 * When an event happens, end included: a multi-day all-day event names its last
 * day (all-day ends are exclusive, at the midnight after it), a timed event its
 * end time. Without the end, an event that started yesterday and runs through
 * tomorrow reads as yesterday's.
 */
export function formatEventSpan(event: Pick<FormattableEvent, "startMs" | "endMs" | "allDay">): string {
  const start = new Date(event.startMs);
  if (event.allDay) {
    const lastDay = new Date(Math.max(event.startMs, event.endMs - 1));
    return sameDay(start, lastDay)
      ? `${formatDate(start)} (all day)`
      : `${formatDate(start)} – ${formatDate(lastDay)} (all day)`;
  }
  if (!(event.endMs > event.startMs)) return formatDateTime(start);
  const end = new Date(event.endMs);
  return sameDay(start, end)
    ? `${formatDateTime(start)} – ${formatTime(end)}`
    : `${formatDateTime(start)} – ${formatDateTime(end)}`;
}

export function formatDateTime(date: Date): string {
  return `${formatDate(date)}, ${formatTime(date)}`;
}

export function formatDate(date: Date): string {
  return `${WEEKDAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

export function formatTime(date: Date): string {
  let hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const meridiem = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${hours}:${minutes} ${meridiem}`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
