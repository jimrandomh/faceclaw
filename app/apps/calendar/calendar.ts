import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage, type UiFont } from "../../graphics/image";
import { wrapText, truncateText } from "../../graphics/textwrap";
import { clamp } from "../../util/numeric-util";
import { getCalendarReadState, readUpcomingEvents, type CalendarEvent } from "../../native/calendar";
import { timeFormatSetting } from "../../ui/dashboard-settings";
import { GESTURE_CLICK, type InputEvent } from "../../ui/gestures";
import { hasCalendarPermission } from "../../native/calendar-permissions";
import { type Layer, type LayerContext } from "../../ui/layers";
import { lineStep } from "../../ui/metrics";
import type { Viewport } from "../../ui/viewport";

/** How far a row's text sits inside its selection box; the title lines up with it. */
const ROW_TEXT_INSET = 10;
/**
 * The title's drop below the window's top padding (the position shared with
 * the other list apps: terminal, notifications), and the distance from its
 * top to the first row.
 */
const TITLE_OFFSET_Y = 2;
const TITLE_BAND = 28;
const ROW_GAP = 4;
const MAX_EVENTS = 50;
/**
 * The message shown in place of the list (no permission, nothing to show):
 * its indent from the title, and its drop below the window's top padding.
 */
const MESSAGE_INDENT = 6;
const MESSAGE_OFFSET_Y = 64;

/** Height of the day header band above a row that starts a new day. */
function dayHeaderHeight(font: UiFont): number {
  return font.lineHeight + 4;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type EventRow = {
  event: CalendarEvent;
  /** Day header text drawn above this row, or null when it shares the prior day. */
  dayHeader: string | null;
  lines: string[];
  height: number;
};

/**
 * The Calendar app's single screen. Without calendar permission it shows a
 * prompt telling the user to grant access on the phone (the launch path also
 * fires the system permission dialog); with permission it lists upcoming
 * events grouped by day, scrollable when they overflow the viewport.
 */
export class CalendarLayer implements Layer {
  private selectedIndex = 0;

  constructor(private readonly requestPermission: () => void) {}

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const viewport = ctx.stack.getBaseSize();
    const { width, height, padding } = viewport;
    const image = new GrayImage(width, height, 0);
    // Rows' selection boxes sit at the padding suggested for the window's
    // side edges; the title lines up with their text.
    const titleX = padding.left + ROW_TEXT_INSET;
    const titleY = padding.top + TITLE_OFFSET_Y;

    if (!hasCalendarPermission()) {
      image.drawText(font, titleX, titleY, "Calendar", 220);
      this.paintPermissionPrompt(image, font, viewport);
      return image;
    }

    const events = readUpcomingEvents(MAX_EVENTS);
    if (!events.length) {
      image.drawText(font, titleX, titleY, "Calendar", 220);
      const state = getCalendarReadState();
      image.drawText(font, titleX + MESSAGE_INDENT, padding.top + MESSAGE_OFFSET_Y, state === "loading" ? "Loading calendar..."
        : state === "error" ? "Calendar unavailable. Try again shortly." : "No upcoming events.", 190);
      return image;
    }

    const rows = buildEventRows(font, events);
    this.selectedIndex = clamp(this.selectedIndex, 0, rows.length - 1);

    // The agenda scrolls, so it runs to the window's top and bottom edges
    // and rows scrolled past an end are cut off right at the edge. The
    // padding suggested for those edges is inside the scrolled content
    // instead: above the title and below the last row.
    const listTop = titleY + TITLE_BAND;
    const scrollY = scrollForSelected(rows, this.selectedIndex, height - listTop, padding.bottom);
    // The title scrolls away with the list; row text is deferred glyphs
    // (composited above raster fills), so a fixed title would show through
    // rows scrolled over it.
    if (titleY - scrollY + font.lineHeight > 0) {
      image.drawText(font, titleX, titleY - scrollY, "Calendar", 220);
    }
    const rowWidth = width - padding.left - padding.right;
    let cursorY = listTop - scrollY;
    for (let index = 0; index < rows.length && cursorY < height; index++) {
      const row = rows[index]!;
      if (cursorY + row.height > 0) {
        drawEventRow(image, font, row, padding.left, cursorY, rowWidth, index === this.selectedIndex);
      }
      cursorY += row.height + ROW_GAP;
    }
    return image;
  }

  handleInput(event: InputEvent): void {
    if (!hasCalendarPermission()) {
      // Any tap on the prompt re-triggers the phone-side permission request.
      if (event.type === "click") this.requestPermission();
      return;
    }
    const rows = buildEventRows(getDefaultSmallFont(), readUpcomingEvents(MAX_EVENTS));
    if (!rows.length) return;
    if (event.type === "scroll-up") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    } else if (event.type === "scroll-down") {
      this.selectedIndex = Math.min(rows.length - 1, this.selectedIndex + 1);
    }
  }

  private paintPermissionPrompt(image: GrayImage, font: UiFont, viewport: Viewport): void {
    const { width, height, padding } = viewport;
    const message = "Grant calendar permission on your phone to see your events on the glasses.";
    // Indented under the title, and as far short of the right padding.
    const indent = ROW_TEXT_INSET + MESSAGE_INDENT;
    const x = padding.left + indent;
    const lines = wrapText(font, message, width - padding.left - padding.right - 2 * indent);
    // The hint rests on the bottom padding; the message keeps to the lines that fit above it.
    const hintY = height - padding.bottom - font.lineHeight;
    const top = padding.top + MESSAGE_OFFSET_Y;
    const maxLines = Math.max(1, Math.floor((hintY - top) / lineStep(font)));
    for (let index = 0; index < Math.min(lines.length, maxLines); index++) {
      image.drawText(font, x, top + index * lineStep(font), lines[index]!, 190);
    }
    image.drawText(font, x, hintY, `${GESTURE_CLICK} request`, 110);
  }
}

function buildEventRows(font: UiFont, events: CalendarEvent[]): EventRow[] {
  const rows: EventRow[] = [];
  let previousDayKey = "";
  for (const event of events) {
    const dayKey = dayKeyOf(event.startMs);
    const dayHeader = dayKey === previousDayKey ? null : dayHeaderLabel(event.startMs);
    previousDayKey = dayKey;

    const lines: string[] = [];
    const timeLabel = event.allDay ? "All day" : formatEventTime(event.startMs);
    lines.push(`${timeLabel}  ${event.title || "(untitled)"}`);
    if (event.location) {
      lines.push(event.location);
    }

    rows.push({
      event,
      dayHeader,
      lines,
      height: (dayHeader ? dayHeaderHeight(font) : 0) + 6 + lines.length * lineStep(font),
    });
  }
  return rows;
}

/** Draw a row whose selection box spans `width` from `x`; its day header and text sit ROW_TEXT_INSET inside that. */
function drawEventRow(
  image: GrayImage,
  font: UiFont,
  row: EventRow,
  x: number,
  y: number,
  width: number,
  selected: boolean,
): void {
  const textX = x + ROW_TEXT_INSET;
  let cursorY = y;
  if (row.dayHeader) {
    image.drawText(font, textX, cursorY + 2, row.dayHeader, 150);
    cursorY += dayHeaderHeight(font);
  }
  const bodyHeight = row.lines.length * lineStep(font) + 4;
  if (selected) {
    image.fillRoundedRect(x, cursorY, width, bodyHeight, 15, 6);
    image.drawRoundedRect(x, cursorY, width, bodyHeight, 90, 6);
  }
  const maxTextWidth = width - 2 * ROW_TEXT_INSET;
  for (let index = 0; index < row.lines.length; index++) {
    const value = index === 0 ? (selected ? 235 : 205) : 160;
    image.drawText(font, textX, cursorY + 3 + index * lineStep(font), truncateText(font, row.lines[index]!, maxTextWidth), value);
  }
}

/**
 * The scroll offset that centers the selected row in `viewportHeight`, the
 * room below the title's resting place, within the ends of what scrolls
 * there: the rows, then `padBottom` after the last of them. So the first
 * row rests with the title and the padding above it in view, and the last
 * with the padding below it.
 */
function scrollForSelected(rows: EventRow[], selectedIndex: number, viewportHeight: number, padBottom: number): number {
  let selectedTop = 0;
  for (let index = 0; index < selectedIndex; index++) {
    selectedTop += rows[index]!.height + ROW_GAP;
  }
  const selectedBottom = selectedTop + rows[selectedIndex]!.height;
  const contentHeight = rows.reduce((sum, row) => sum + row.height + ROW_GAP, -ROW_GAP) + padBottom;
  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  const centered = selectedTop - Math.max(0, (viewportHeight - (selectedBottom - selectedTop)) / 2);
  return clamp(centered | 0, 0, maxScroll);
}

function dayKeyOf(timestampMs: number): string {
  const date = new Date(timestampMs);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function dayHeaderLabel(timestampMs: number): string {
  const date = new Date(timestampMs);
  const now = new Date();
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDelta = Math.round((midnight(date) - midnight(now)) / (24 * 60 * 60 * 1000));
  const base = `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
  if (dayDelta === 0) return `Today  ${base}`;
  if (dayDelta === 1) return `Tomorrow  ${base}`;
  return base;
}

export function formatEventTime(timestampMs: number): string {
  const date = new Date(timestampMs);
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const hour24 = date.getHours();
  if (timeFormatSetting.get() === "12h") {
    const hour12 = ((hour24 + 11) % 12) + 1;
    return `${hour12}:${minutes} ${hour24 < 12 ? "AM" : "PM"}`;
  }
  return `${String(hour24).padStart(2, "0")}:${minutes}`;
}
