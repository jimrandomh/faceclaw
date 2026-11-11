import type { Viewport } from "../../ui/viewport";

type TranscriptEvent = {
  text: string;
  isFinal: boolean;
  transcribeText?: string;
  paragraphBreakAfter?: boolean;
};

/** Text accumulation belongs to this app, not the shared dictation stream. */
export class TranscriptModel {
  private finalized = "";
  private live = "";
  private separator = " ";
  private breakAfterLive = false;

  get text(): string {
    return this.finalized && this.live ? this.finalized + this.separator + this.live : this.finalized || this.live;
  }

  accept(event: TranscriptEvent): void {
    const text = (event.transcribeText ?? event.text).trim();
    if (!event.isFinal) {
      this.live = text;
      return;
    }
    const finalText = text || this.live;
    if (finalText) this.finalized = this.finalized ? this.finalized + this.separator + finalText : finalText;
    this.live = "";
    if (finalText) this.separator = event.paragraphBreakAfter || this.breakAfterLive ? "\n" : " ";
    this.breakAfterLive = false;
  }

  /** The onboard recognizer may finalize just before or just after the pause. */
  pause(): void {
    if (this.live) this.breakAfterLive = true;
    else if (this.finalized) this.separator = "\n";
  }
}

/** An absolute history position, with an explicit follow-tail mode. */
export class TranscriptScroll {
  firstLine = 0;
  private maximum = 0;
  private following = true;

  layout(totalLines: number, visibleLines: number): number {
    this.maximum = Math.max(0, totalLines - visibleLines);
    this.firstLine = this.following ? this.maximum : Math.min(this.firstLine, this.maximum);
    return this.firstLine;
  }

  scroll(delta: number): void {
    this.firstLine = Math.max(0, Math.min(this.maximum, this.firstLine + delta));
    this.following = this.firstLine === this.maximum;
  }
}

/** The scrollbar, and the room the transcript's lines leave for it at their right. */
const SCROLLBAR_WIDTH = 2;
const SCROLLBAR_GUTTER = 8;

export type TranscriptLayout = {
  /** The text column: its left, and the width its lines wrap to. */
  textX: number;
  textWidth: number;
  /** Lines the view scrolls by: as many as fit above the bottom padding. */
  pageLines: number;
  /** Lines to draw from the first one shown: as many as fit above the window's bottom edge. */
  drawnLines: number;
  /** The scrollbar's track, for a transcript longer than a page. */
  scrollbar: { x: number; y: number; width: number; height: number };
};

/**
 * Where a listening view (Transcribe, Translate) puts its transcript, under
 * a fixed header that ends at `top`. The text column starts at the padding
 * suggested for the window's left edge (viewport.ts), in line with the
 * header's title, and stops short of the right edge's by the scrollbar's
 * gutter; the scrollbar stands in that, against the padding. The lines
 * scroll, so they run to the window's bottom edge: the view scrolls by the
 * lines that fit above that edge's padding, which rests the transcript's
 * last line clear of a border there, and while more lines follow it draws
 * as many as fit above the edge itself.
 */
export function transcriptLayout(viewport: Viewport, top: number, lineHeight: number, step: number): TranscriptLayout {
  const { width, height, padding } = viewport;
  const linesAbove = (bottom: number) => Math.max(1, Math.floor((bottom - top - lineHeight) / step) + 1);
  return {
    textX: padding.left,
    textWidth: Math.max(0, width - padding.left - padding.right - SCROLLBAR_GUTTER),
    pageLines: linesAbove(height - padding.bottom),
    drawnLines: linesAbove(height),
    scrollbar: {
      x: width - padding.right - SCROLLBAR_WIDTH,
      y: top,
      width: SCROLLBAR_WIDTH,
      height: Math.max(0, height - padding.bottom - top),
    },
  };
}

export function wrapTranscribeText(measure: (text: string) => number, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && measure(candidate) > maxWidth) {
        lines.push(line);
        line = "";
      }
      if (measure(word) <= maxWidth) {
        line = line ? `${line} ${word}` : word;
        continue;
      }
      // Long URLs and unspaced languages must not run off the display.
      for (const char of (line ? " " : "") + word) {
        if (line && measure(line + char) > maxWidth) {
          lines.push(line);
          line = "";
        }
        line += char;
      }
    }
    lines.push(line);
  }
  return lines;
}
