import { GrayImage, type UiFont } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { lineStep } from "../../ui/metrics";
import { GESTURE_DOUBLE_CLICK, GESTURE_SCROLL, type InputEvent } from "../../ui/gestures";
import { Layer, type LayerContext } from "../../ui/layers";
import { micSession, type CaptionLine, type MicSessionState } from "./mic-session";

/** From the title's top to the first caption row. */
const BODY_TOP_OFFSET = 20;
/** Indent of the caption rows under the title. */
const ROW_INDENT = 4;

/**
 * On-glasses captions: each line is prefixed with the speaker's name (their
 * id until tagged); foreign-language lines show the translation directly
 * beneath the recognized original. Scroll reviews recent lines; the view
 * snaps back to live on new speech.
 *
 * The title and the hint line stay put, at the padding suggested for the
 * window's top and bottom edges; the caption rows scroll between the two.
 */
export class CaptionsLayer implements Layer {
  private state: MicSessionState = micSession.getState();
  private unsubscribe: (() => void) | null = null;
  private scrollback = 0;
  private lastLine: CaptionLine | null = null;

  start(requestRender: () => void): void {
    this.unsubscribe = micSession.onState((state) => {
      // Watch the newest line itself: once the session's line cap is reached
      // the count stops changing even though new speech keeps arriving.
      const last = state.captionLines[state.captionLines.length - 1] ?? null;
      if (last !== this.lastLine) {
        this.lastLine = last;
        this.scrollback = 0;
      }
      this.state = state;
      requestRender();
    });
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height, padding } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const state = this.state;
    const left = padding.left;
    const rowX = left + ROW_INDENT;
    const bodyTop = padding.top + BODY_TOP_OFFSET;

    image.drawText(font, left, padding.top, "Captions", 220);
    if (!state.captionsActive) {
      image.drawText(font, left, bodyTop + 2, state.captionsNote, 130);
    }

    const rows = this.buildRows(font, Math.max(0, width - padding.right - rowX), state.captionLines);
    const step = lineStep(font) + 1;
    const footerY = height - padding.bottom - font.lineHeight;
    const visibleRows = Math.max(1, Math.floor((footerY - bodyTop) / step));
    const maxScrollback = Math.max(0, rows.length - visibleRows);
    this.scrollback = Math.min(this.scrollback, maxScrollback);
    const firstRow = Math.max(0, rows.length - visibleRows - this.scrollback);
    for (let index = firstRow; index < Math.min(rows.length, firstRow + visibleRows); index++) {
      const row = rows[index]!;
      const y = bodyTop + (index - firstRow) * step;
      if (row.prefix) {
        image.drawText(font, rowX, y, row.prefix, row.prefixValue);
        image.drawText(font, rowX + font.measureText(row.prefix), y, row.text, row.value);
      } else {
        image.drawText(font, rowX + row.indent, y, row.text, row.value);
      }
    }

    image.drawText(
      font,
      left,
      footerY,
      `${GESTURE_SCROLL} history   ${GESTURE_DOUBLE_CLICK} back` +
        (this.scrollback > 0 ? `   (${this.scrollback} back)` : ""),
      110,
    );
    return image;
  }

  private buildRows(
    font: UiFont,
    maxWidth: number,
    lines: CaptionLine[],
  ): Array<{ prefix?: string; prefixValue: number; text: string; value: number; indent: number }> {
    const rows: Array<{ prefix?: string; prefixValue: number; text: string; value: number; indent: number }> = [];
    for (const line of lines) {
      const prefix = `${line.speakerName}: `;
      const prefixWidth = font.measureText(prefix);
      const wrapped = wrapWords(font, line.text, maxWidth - prefixWidth);
      wrapped.forEach((text, index) => {
        rows.push({
          prefix: index === 0 ? prefix : undefined,
          prefixValue: line.isWearer ? 255 : 170,
          text,
          value: 230,
          indent: index === 0 ? 0 : prefixWidth,
        });
      });
      if (line.translation) {
        for (const text of wrapWords(font, `→ ${line.translation}`, maxWidth - prefixWidth)) {
          rows.push({ prefixValue: 0, text, value: 140, indent: prefixWidth });
        }
      }
    }
    return rows;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    switch (event.type) {
      case "scroll-up":
        this.scrollback += 1;
        return;
      case "scroll-down":
        this.scrollback = Math.max(0, this.scrollback - 1);
        return;
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }

  onRemoved(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

function wrapWords(font: UiFont, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && font.measureText(candidate) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}
