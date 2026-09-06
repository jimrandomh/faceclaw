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
