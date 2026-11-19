import { type GrayImage, type UiFont } from "../../../graphics/image";
import { truncateText } from "../../../graphics/textwrap";
import { hasCalendarPermission } from "../../../native/calendar-permissions";
import { getCalendarReadState, onCalendarChanged, readUpcomingEvents, type CalendarEvent } from "../../../native/calendar";
import { lineStep } from "../../../ui/metrics";
import { dayHeaderLabel, eventTimeLabel, formatEventTime } from "../../calendar/calendar";
import { endTimeLabel, listingDayMs, spanLabel, spansDays } from "../../calendar/event-days";
import { glanceFont } from "../glance-font";
import { type GlanceWidget } from "../widget";

const PAD = 8;
/** A row fits while its glyph line clears this margin above the bottom edge. */
const BOTTOM_MARGIN = 2;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * What is next on the calendar: the current or next event large, with how
 * far off it is (or when it ends), then the following events grouped under
 * day headers, as many as fit. Reads the same cached provider query as the
 * Calendar app; a minute tick keeps the countdown honest and lets the
 * 30-second cache refresh on its own.
 */
export class CalendarWidget implements GlanceWidget {
  private tick: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  start(requestRender: () => void): void {
    this.stop();
    this.unsubscribe = onCalendarChanged(requestRender);
    this.tick = setInterval(requestRender, MINUTE_MS);
  }

  stop(): void {
    if (this.tick !== null) clearInterval(this.tick);
    this.tick = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  paint(image: GrayImage): void {
    const small = glanceFont.small();
    const medium = glanceFont.medium();
    const step = lineStep(small);
    const textWidth = image.width - 2 * PAD;

    if (!hasCalendarPermission()) {
      image.drawText(small, PAD, PAD, "Calendar", 150);
      image.drawText(small, PAD, PAD + step + 4, "Calendar permission needed", 140);
      image.drawText(small, PAD, PAD + 2 * step + 4, "Open the Calendar app to grant it", 100);
      return;
    }
    const nowMs = Date.now();
    // Events still in progress count; the provider's window starts at "now",
    // so the list can include an event that began earlier and is still on.
    const events = readUpcomingEvents().filter((event) => event.endMs > nowMs);
    if (!events.length) {
      image.drawText(small, PAD, PAD, "Calendar", 150);
      const state = getCalendarReadState();
      image.drawText(small, PAD, PAD + step + 4, state === "loading" ? "Loading calendar..."
        : state === "error" ? "Calendar unavailable" : "No upcoming events", 140);
      return;
    }

    // Headline: the current or next event, with its day when it is not today.
    const next = events[0]!;
    let y = PAD;
    const headline = truncateText(medium, next.title || "(untitled)", textWidth);
    image.drawText(medium, PAD, y, headline, 230);
    y += medium.lineHeight + 2;
    image.drawText(small, PAD, y, truncateText(small, headlineDetail(next, nowMs), textWidth), 170);
    y += step + 6;

    // The rest, grouped by day. A day header only where the day changes from
    // the previous listed event (the headline's day included). An event still
    // going since an earlier day counts as today's, as in the Calendar app.
    let previousDayKey = dayKeyOf(listingDayMs(next, nowMs));
    for (let index = 1; index < events.length; index++) {
      const event = events[index]!;
      const listedMs = listingDayMs(event, nowMs);
      const dayKey = dayKeyOf(listedMs);
      const needsHeader = dayKey !== previousDayKey;
      // The header and its row are placed a step apart; the row only needs
      // its line height to fit above the bottom margin.
      if (y + (needsHeader ? step : 0) + small.lineHeight > image.height - BOTTOM_MARGIN) break;
      if (needsHeader) {
        image.drawText(small, PAD, y, truncateText(small, dayHeaderLabel(listedMs), textWidth), 120);
        y += step;
        previousDayKey = dayKey;
      }
      drawEventLine(image, small, PAD, y, textWidth, event, nowMs, 190);
      y += step;
    }
  }
}

/**
 * "Now, ends 14:30", "In 25 min", "Tomorrow 09:00", "All day"... for the
 * headline. An event covering several days names its span or the day it ends,
 * so one that began days ago doesn't read as that day's.
 */
function headlineDetail(event: CalendarEvent, nowMs: number): string {
  const dayDelta = dayDeltaFromToday(event.startMs);
  const multiDay = spansDays(event);
  const when = event.allDay
    ? (multiDay ? spanLabel(event) : "All day")
    : `${formatEventTime(event.startMs)} - ${endTimeLabel(event, event.startMs, formatEventTime)}`;
  if (event.startMs <= nowMs) {
    if (event.allDay) return multiDay ? `All day, ${spanLabel(event)}` : "All day today";
    return `Now, ends ${endTimeLabel(event, nowMs, formatEventTime)}`;
  }
  const untilMs = event.startMs - nowMs;
  if (dayDelta === 0 && untilMs < 12 * HOUR_MS) {
    return `In ${formatDuration(untilMs)}, ${when}`;
  }
  const day = dayDelta === 0 ? "Today" : dayDelta === 1 ? "Tomorrow" : dayHeaderLabel(event.startMs);
  return `${day}, ${when}`;
}

function drawEventLine(
  image: GrayImage,
  font: UiFont,
  x: number,
  y: number,
  width: number,
  event: CalendarEvent,
  nowMs: number,
  value: number,
): void {
  const time = eventTimeLabel(event, nowMs);
  const timeWidth = font.measureText(time);
  image.drawText(font, x, y, time, value - 50);
  const titleX = x + timeWidth + 8;
  image.drawText(font, titleX, y, truncateText(font, event.title || "(untitled)", Math.max(0, x + width - titleX)), value);
}

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function dayKeyOf(timestampMs: number): string {
  const date = new Date(timestampMs);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayDeltaFromToday(timestampMs: number): number {
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((midnight(new Date(timestampMs)) - midnight(new Date())) / (24 * HOUR_MS));
}
