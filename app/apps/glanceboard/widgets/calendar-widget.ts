import { type GrayImage, type UiFont } from "../../../graphics/image";
import { truncateText } from "../../../graphics/textwrap";
import { getDefaultMediumFont, getDefaultSmallFont } from "../../../graphics/ui-fonts";
import { hasCalendarPermission } from "../../../g2/android-permissions";
import { readUpcomingEvents, type CalendarEvent } from "../../../native/calendar";
import { lineStep } from "../../../ui/metrics";
import { dayHeaderLabel, formatEventTime } from "../../calendar/calendar";
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

  start(requestRender: () => void): void {
    this.tick = setInterval(requestRender, MINUTE_MS);
  }

  stop(): void {
    if (this.tick !== null) clearInterval(this.tick);
    this.tick = null;
  }

  paint(image: GrayImage): void {
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
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
      image.drawText(small, PAD, PAD + step + 4, "No upcoming events", 140);
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
    // the previous listed event (the headline's day included).
    let previousDayKey = dayKeyOf(next.startMs);
    for (let index = 1; index < events.length; index++) {
      const event = events[index]!;
      const dayKey = dayKeyOf(event.startMs);
      const needsHeader = dayKey !== previousDayKey;
      // The header and its row are placed a step apart; the row only needs
      // its line height to fit above the bottom margin.
      if (y + (needsHeader ? step : 0) + small.lineHeight > image.height - BOTTOM_MARGIN) break;
      if (needsHeader) {
        image.drawText(small, PAD, y, truncateText(small, dayHeaderLabel(event.startMs), textWidth), 120);
        y += step;
        previousDayKey = dayKey;
      }
      drawEventLine(image, small, PAD, y, textWidth, event, 190);
      y += step;
    }
  }
}

/** "Now, ends 14:30", "In 25 min", "Tomorrow 09:00", "All day"... for the headline. */
function headlineDetail(event: CalendarEvent, nowMs: number): string {
  const dayDelta = dayDeltaFromToday(event.startMs);
  const when = event.allDay
    ? "All day"
    : `${formatEventTime(event.startMs)} - ${formatEventTime(event.endMs)}`;
  if (event.startMs <= nowMs) {
    if (event.allDay) return dayDelta === 0 ? "All day today" : `All day, ${dayHeaderLabel(event.startMs)}`;
    return `Now, ends ${formatEventTime(event.endMs)}`;
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
  value: number,
): void {
  const time = event.allDay ? "All day" : formatEventTime(event.startMs);
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
