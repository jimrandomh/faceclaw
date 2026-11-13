import { GrayImage } from "../../graphics/image";
import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_SCROLL, gestureHints, type InputEvent } from "../../ui/gestures";
import type { Layer, LayerContext, PaintBelow } from "../../ui/layers";
import { CONTEXT_MENU_DIM } from "../../ui/menu";
import { centeredTextY } from "../../ui/metrics";
import { formatReplayTime, stepReplaySeconds, TIME_FIELDS, type TimeField } from "./replay-time";

const PADDING = 12;
const FIELD_GAP = 6;
const FIELD_PAD_X = 6;
/** Fill and outline of the active field (the Timers and date pickers' field style). */
const ACTIVE_FILL = 35;
const ACTIVE_STROKE = 130;

export type TimePickerOptions = {
  title: string;
  /** Where the picker starts, and the furthest it goes, in ms. */
  initialMs: number;
  maxMs: number;
  onPick: (positionMs: number) => void;
};

/**
 * A modal position picker for a recording: hours (when the recording has
 * any), minutes and seconds, over the dimmed content beneath. Input follows
 * the date picker's: scroll adjusts the active field (up is later, carrying
 * into the fields beside it), click moves to the next field and on the last
 * one picks, double-click steps back a field and on the first one cancels.
 * A watch's swipes move between fields and adjust.
 */
export class TimePickerLayer implements Layer {
  readonly acceptsDirectional = true;
  readonly dimUnderneath = CONTEXT_MENU_DIM;
  private readonly fields: readonly TimeField[];
  private readonly maxSeconds: number;
  private seconds: number;
  private field = 0;

  constructor(private readonly options: TimePickerOptions) {
    this.maxSeconds = Math.max(0, Math.floor(options.maxMs / 1000));
    this.seconds = Math.max(0, Math.min(this.maxSeconds, Math.floor(options.initialMs / 1000)));
    this.fields = this.maxSeconds >= 3600 ? TIME_FIELDS : TIME_FIELDS.slice(1);
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
        this.field = Math.min(this.fields.length - 1, this.field + 1);
        return;
      case "swipe-left":
        this.field = Math.max(0, this.field - 1);
        return;
      case "click":
        if (this.field < this.fields.length - 1) {
          this.field++;
        } else {
          ctx.stack.pop();
          this.options.onPick(this.seconds * 1000);
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
    this.seconds = stepReplaySeconds(this.seconds, this.fields[this.field]!, delta, this.maxSeconds);
  }

  private hints(field: number): string {
    return gestureHints([
      [GESTURE_SCROLL, "adjust"],
      [GESTURE_CLICK, field < this.fields.length - 1 ? "next" : "jump"],
      [GESTURE_DOUBLE_CLICK, field > 0 ? "back" : "cancel"],
    ]);
  }

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    const image = paintBelow();
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const focused = ctx.stack.isFocused();
    const base = ctx.stack.getBaseSize();

    const values = [
      String(Math.floor(this.seconds / 3600)),
      String(Math.floor((this.seconds % 3600) / 60)).padStart(this.fields.length === 3 ? 2 : 1, "0"),
      String(this.seconds % 60).padStart(2, "0"),
    ].slice(TIME_FIELDS.length - this.fields.length);
    // Sized for the widest value a field can show, so the dialog holds still while the time changes.
    const fieldWidths = this.fields.map(
      (field) => Math.max(medium.measureText("000"), small.measureText(field)) + 2 * FIELD_PAD_X,
    );
    const fieldsWidth = fieldWidths.reduce((sum, width) => sum + width, 0) + FIELD_GAP * (fieldWidths.length - 1);
    const boxHeight = medium.lineHeight + 6;
    const length = `of ${formatReplayTime(this.maxSeconds * 1000)}`;
    const hintsWidth = Math.max(...this.fields.map((_, index) => small.measureText(this.hints(index))));
    const width = Math.min(
      base.width,
      Math.max(fieldsWidth, hintsWidth, small.measureText(this.options.title), small.measureText(length)) + 2 * PADDING,
    );
    const titleHeight = small.lineHeight + 12;
    const bodyHeight = boxHeight + 2 + small.lineHeight + 10 + small.lineHeight;
    const height = Math.min(base.height, 8 + titleHeight + bodyHeight + 12 + small.lineHeight + 10);
    const x = Math.max(0, Math.floor((base.width - width) / 2));
    const y = Math.max(0, Math.floor((base.height - height) / 2));

    // Fill 1, not 0: 0 is the transparent color key on the shell surface.
    image.fillRoundedRect(x, y, width, height, 1);
    image.drawRoundedRect(x, y, width, height, 72);
    image.drawText(small, x + PADDING, y + 8, this.options.title, 220);

    const top = y + 8 + titleHeight;
    let fieldX = x + PADDING;
    for (let index = 0; index < this.fields.length; index++) {
      const fieldWidth = fieldWidths[index]!;
      const active = index === this.field;
      if (active) {
        if (focused) image.fillRoundedRect(fieldX, top, fieldWidth, boxHeight, ACTIVE_FILL, 6);
        image.drawRoundedRect(fieldX, top, fieldWidth, boxHeight, ACTIVE_STROKE, 6);
      }
      const value = values[index]!;
      image.drawText(medium, fieldX + Math.floor((fieldWidth - medium.measureText(value)) / 2),
        centeredTextY(medium, top, boxHeight), value, active ? 250 : 170);
      const caption = this.fields[index]!;
      image.drawText(small, fieldX + Math.floor((fieldWidth - small.measureText(caption)) / 2),
        top + boxHeight + 2, caption, active ? 190 : 110);
      fieldX += fieldWidth + FIELD_GAP;
    }
    image.drawText(small, x + PADDING, top + bodyHeight - small.lineHeight, length, 190);
    image.drawText(small, x + PADDING, y + height - 10 - small.lineHeight, this.hints(this.field), 110);
    return image;
  }
}
