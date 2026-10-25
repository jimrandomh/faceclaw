import { GrayImage, type UiFont } from "../graphics/image";
import { truncateText } from "../graphics/textwrap";
import { getDefaultMediumFont, getDefaultSmallFont } from "../graphics/ui-fonts";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_SCROLL, gestureHints, type InputEvent } from "./gestures";
import type { Layer, LayerContext, PaintBelow } from "./layers";
import { CONTEXT_MENU_DIM } from "./menu";
import { centeredTextY } from "./metrics";

/** A calendar day with no time or zone attached; month is 0-11, as in Date. */
export type CalendarDay = { year: number; month: number; day: number };

/** The picker's fields, in display and click order. */
export const DATE_FIELDS = ["day", "month", "year"] as const;
export type DateField = (typeof DATE_FIELDS)[number];

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_HEADERS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
/** Year bounds: four digits, and clear of Date's 0-99 => 1900s mapping. */
const MIN_YEAR = 1000;
const MAX_YEAR = 9999;
const DAY_MS = 86_400_000;

const PADDING = 12;
const COLUMN_GAP = 24;
const FIELD_GAP = 8;
const FIELD_PAD_X = 6;
/** Fill and outline of the active field and the selected day (the Timers pickers' field style). */
const ACTIVE_FILL = 35;
const ACTIVE_STROKE = 130;
const TODAY_STROKE = 60;

export function calendarDayOf(date: Date): CalendarDay {
  return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() };
}

/** Local midnight on the given day. */
export function calendarDayToDate({ year, month, day }: CalendarDay): Date {
  return new Date(year, month, day);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: CalendarDay, to: CalendarDay): number {
  return Math.round((Date.UTC(to.year, to.month, to.day) - Date.UTC(from.year, from.month, from.day)) / DAY_MS);
}

/**
 * Step a day by `delta` of a field's unit. Day steps are date arithmetic,
 * rolling into neighboring months and years. Month and year steps keep the
 * day of month, clamped to the target month's length; they aim for
 * `preferredDay` (the day last picked) so stepping from Jan 31 through
 * February lands on Mar 31 again. A step past the year bounds is refused.
 */
export function stepCalendarDay(date: CalendarDay, field: DateField, delta: number, preferredDay = date.day): CalendarDay {
  let next: CalendarDay;
  if (field === "day") {
    next = calendarDayOf(new Date(date.year, date.month, date.day + delta));
  } else {
    const months = date.year * 12 + date.month + (field === "month" ? delta : delta * 12);
    const year = Math.floor(months / 12);
    const month = months - year * 12;
    next = { year, month, day: Math.min(preferredDay, daysInMonth(year, month)) };
  }
  return next.year < MIN_YEAR || next.year > MAX_YEAR ? date : next;
}

/** "today", "yesterday", "in 3 days"... for a day relative to today. */
export function relativeDayLabel(date: CalendarDay, today: CalendarDay): string {
  const days = daysBetween(today, date);
  if (days === 0) return "today";
  if (days === -1) return "yesterday";
  if (days === 1) return "tomorrow";
  return days < 0 ? `${-days} days ago` : `in ${days} days`;
}

export type DatePickerOptions = {
  title: string;
  /** The day to start on (its local calendar day). Default: today. */
  initial?: Date;
  /** Hint for the final click, e.g. "open". Default "done". */
  confirmLabel?: string;
  /** Called with the picked day, as local midnight, after the picker has closed. */
  onPick: (date: Date) => void;
  /** Called when the picker closes without a pick: cancelled, or cleared away by its host. */
  onCancel?: () => void;
};

/**
 * A modal date picker: day, month and year fields beside a month calendar,
 * in a dialog centered on its stack's base (an app window, or the shell
 * surface) with the content beneath dimmed like a context menu's. Pushed on
 * a LayerStack, it works in in-process apps and in worker apps alike (a
 * worker pushes it from a WindowMenu item, whose stack then hosts it).
 *
 * Input follows the Timers app's field pickers: scroll adjusts the active
 * field (up is later), click moves to the next field and on the last one
 * picks the date, double-click steps back a field and on the first one
 * cancels. A watch's swipes move between fields (left / right) and adjust
 * (up / down). Steps are date arithmetic rather than per-field wrapping (see
 * stepCalendarDay), so a nearby day needs only the day field.
 */
export class DatePickerLayer implements Layer {
  readonly acceptsDirectional = true;
  readonly dimUnderneath = CONTEXT_MENU_DIM;
  private date: CalendarDay;
  /** The day of month to aim for when month or year steps pass through shorter months. */
  private preferredDay: number;
  private field = 0;
  /** Picked or cancelled: onRemoved must not report a cancel. */
  private finished = false;

  constructor(private readonly options: DatePickerOptions) {
    this.date = calendarDayOf(options.initial ?? new Date());
    this.preferredDay = this.date.day;
  }

  /** The day currently shown. */
  get value(): CalendarDay {
    return { ...this.date };
  }

  get activeField(): DateField {
    return DATE_FIELDS[this.field]!;
  }

  onRemoved(): void {
    if (this.finished) return;
    this.finished = true;
    this.options.onCancel?.();
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    switch (event.type) {
      case "scroll-up":
      case "swipe-up":
        this.adjust(1);
        return;
      case "scroll-down":
      case "swipe-down":
        this.adjust(-1);
        return;
      case "swipe-right":
        this.field = Math.min(DATE_FIELDS.length - 1, this.field + 1);
        return;
      case "swipe-left":
        this.field = Math.max(0, this.field - 1);
        return;
      case "click":
        if (this.field < DATE_FIELDS.length - 1) {
          this.field++;
        } else {
          this.finished = true;
          ctx.stack.pop();
          this.options.onPick(calendarDayToDate(this.date));
        }
        return;
      case "double-click":
        if (this.field > 0) this.field--;
        else ctx.stack.pop();
        return;
      default:
        return;
    }
  }

  private adjust(delta: number): void {
    const field = this.activeField;
    this.date = stepCalendarDay(this.date, field, delta, this.preferredDay);
    if (field === "day") this.preferredDay = this.date.day;
  }

  private hints(field: number): string {
    return gestureHints([
      [GESTURE_SCROLL, "adjust"],
      [GESTURE_CLICK, field < DATE_FIELDS.length - 1 ? "next" : this.options.confirmLabel ?? "done"],
      [GESTURE_DOUBLE_CLICK, field > 0 ? "back" : "cancel"],
    ]);
  }

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    const image = paintBelow();
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const focused = ctx.stack.isFocused();
    const base = ctx.stack.getBaseSize();

    // Sized for the widest value each field and line can show, so the dialog
    // holds still while the date changes.
    const fieldWidths = [
      medium.measureText("00"),
      Math.max(...MONTH_NAMES.map((name) => medium.measureText(name))),
      medium.measureText("0000"),
    ].map((width, index) => Math.max(width, small.measureText(DATE_FIELDS[index]!)) + 2 * FIELD_PAD_X);
    const fieldsWidth = fieldWidths.reduce((sum, width) => sum + width, 0) + FIELD_GAP * (fieldWidths.length - 1);
    const boxHeight = medium.lineHeight + 6;
    const leftWidth = Math.max(fieldsWidth, small.measureText("Wednesday · 999 days ago"));
    const leftHeight = boxHeight + 2 + small.lineHeight + 12 + small.lineHeight;
    const cellWidth = Math.max(small.measureText("00"), ...WEEKDAY_HEADERS.map((name) => small.measureText(name))) + 8;
    const cellHeight = small.lineHeight + 4;
    const gridWidth = 7 * cellWidth;
    // A header row plus six weeks, the most a month spans.
    const gridHeight = 7 * cellHeight;
    const hintsWidth = Math.max(...DATE_FIELDS.map((_, index) => small.measureText(this.hints(index))));
    const chrome = (bodyWidth: number) => Math.max(bodyWidth, hintsWidth, small.measureText(this.options.title)) + 2 * PADDING;
    const titleHeight = small.lineHeight + 12;
    const footerHeight = 12 + small.lineHeight + 10;
    const chromeHeight = 8 + titleHeight + footerHeight;

    // Drop the calendar when the dialog would not fit beside it.
    let width = chrome(leftWidth + COLUMN_GAP + gridWidth);
    let bodyHeight = Math.max(leftHeight, gridHeight);
    const showGrid = width <= base.width - 16 && chromeHeight + bodyHeight <= base.height - 8;
    if (!showGrid) {
      width = Math.min(chrome(leftWidth), base.width);
      bodyHeight = leftHeight;
    }
    const height = Math.min(chromeHeight + bodyHeight, base.height);
    const x = Math.max(0, Math.floor((base.width - width) / 2));
    const y = Math.max(0, Math.floor((base.height - height) / 2));

    // Fill 1, not 0: 0 is the transparent color key on the shell surface.
    image.fillRoundedRect(x, y, width, height, 1);
    image.drawRoundedRect(x, y, width, height, 72);
    image.drawText(small, x + PADDING, y + 8, truncateText(small, this.options.title, width - 2 * PADDING), 220);

    const bodyTop = y + 8 + titleHeight;
    const leftX = x + PADDING;
    const leftTop = bodyTop + Math.floor((bodyHeight - leftHeight) / 2);
    this.paintFields(image, medium, small, leftX, leftTop, fieldWidths, boxHeight, focused);
    const today = calendarDayOf(new Date());
    const weekday = calendarDayToDate(this.date).getDay();
    const summary = `${WEEKDAY_NAMES[weekday]} · ${relativeDayLabel(this.date, today)}`;
    image.drawText(small, leftX, leftTop + leftHeight - small.lineHeight,
      truncateText(small, summary, showGrid ? leftWidth : width - 2 * PADDING), 190);
    if (showGrid) {
      this.paintMonth(image, small, x + width - PADDING - gridWidth, bodyTop, cellWidth, cellHeight, today, focused);
    }
    image.drawText(small, x + PADDING, y + height - 10 - small.lineHeight, this.hints(this.field), 110);
    return image;
  }

  /** The three fields as boxes with captions beneath; the active one highlighted. */
  private paintFields(image: GrayImage, font: UiFont, captionFont: UiFont, x: number, y: number,
      widths: number[], boxHeight: number, focused: boolean): void {
    const values = [String(this.date.day), MONTH_NAMES[this.date.month]!, String(this.date.year)];
    for (let index = 0; index < DATE_FIELDS.length; index++) {
      const width = widths[index]!;
      const active = index === this.field;
      if (active) {
        if (focused) image.fillRoundedRect(x, y, width, boxHeight, ACTIVE_FILL, 6);
        image.drawRoundedRect(x, y, width, boxHeight, ACTIVE_STROKE, 6);
      }
      const value = values[index]!;
      image.drawText(font, x + Math.floor((width - font.measureText(value)) / 2), centeredTextY(font, y, boxHeight),
        value, active ? 250 : 170);
      const caption = DATE_FIELDS[index]!;
      image.drawText(captionFont, x + Math.floor((width - captionFont.measureText(caption)) / 2), y + boxHeight + 2,
        caption, 110);
      x += width + FIELD_GAP;
    }
  }

  /** The shown month as a Sunday-first grid: the picked day highlighted, today outlined. */
  private paintMonth(image: GrayImage, font: UiFont, x: number, y: number, cellWidth: number, cellHeight: number,
      today: CalendarDay, focused: boolean): void {
    const { year, month, day: picked } = this.date;
    for (let column = 0; column < 7; column++) {
      const header = WEEKDAY_HEADERS[column]!;
      image.drawText(font, x + column * cellWidth + Math.floor((cellWidth - font.measureText(header)) / 2),
        centeredTextY(font, y, cellHeight), header, 110);
    }
    const firstWeekday = new Date(year, month, 1).getDay();
    const todayInMonth = today.year === year && today.month === month ? today.day : 0;
    for (let day = 1, count = daysInMonth(year, month); day <= count; day++) {
      const slot = firstWeekday + day - 1;
      const cellX = x + (slot % 7) * cellWidth;
      const cellY = y + (1 + Math.floor(slot / 7)) * cellHeight;
      const selected = day === picked;
      if (selected) {
        if (focused) image.fillRoundedRect(cellX + 1, cellY, cellWidth - 2, cellHeight, ACTIVE_FILL, 4);
        image.drawRoundedRect(cellX + 1, cellY, cellWidth - 2, cellHeight, ACTIVE_STROKE, 4);
      } else if (day === todayInMonth) {
        image.drawRoundedRect(cellX + 1, cellY, cellWidth - 2, cellHeight, TODAY_STROKE, 4);
      }
      const text = String(day);
      image.drawText(font, cellX + Math.floor((cellWidth - font.measureText(text)) / 2),
        centeredTextY(font, cellY, cellHeight), text, selected ? 255 : day === todayInMonth ? 220 : 170);
    }
  }
}
