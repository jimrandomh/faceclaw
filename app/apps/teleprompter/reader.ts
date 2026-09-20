import { GrayImage, type UiFont } from "../../graphics/image";
import { truncateText } from "../../graphics/textwrap";
import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { voiceControlBridge, type VoiceTranscriptEvent } from "../../native/voice-control";
import { type InputEvent } from "../../ui/gestures";
import { Layer, type LayerContext } from "../../ui/layers";
import { type MenuItem } from "../../ui/menu";
import { lineStep } from "../../ui/metrics";
import { clamp } from "../../util/numeric-util";
import { ScriptTracker, tokenizeScript, type TokenizedScript } from "./script-tracker";

const MARGIN_X = 18;
const BODY_TOP = 6;
/** Gap between the last body line and the footer. */
const FOOTER_GAP = 4;
/** Lines per ring scroll tick. */
const SCROLL_STEP_LINES = 2;

/** Brightness of words already spoken, still to come, and the next one. */
const PAST_VALUE = 90;
const UPCOMING_VALUE = 200;
const NEXT_VALUE = 255;

type LayoutSpan = { tokenIndex: number; x: number; width: number; text: string };
type LayoutLine = { spans: LayoutSpan[] };

export type ReaderHooks = {
  requestRender: () => void;
  /** Hold continuous mic capture while tracking is on. */
  startCapture: () => void;
  stopCapture: () => void;
  /** The reader closed (or paused) at this word position. */
  savePosition: (position: number) => void;
};

/**
 * The teleprompter's reading view. Lays the script out word by word in the
 * medium UI font, follows the speaker through it from the live transcript
 * (see ScriptTracker), auto-scrolls to keep the next word about a third of
 * the way down, and highlights that word. Ring scrolls move the view by hand
 * and re-anchor the tracker to what is now at the anchor row, so scrolling
 * doubles as "I'm here now". Click pauses/resumes tracking; double-click
 * goes back to the file list.
 */
export class TeleprompterReaderLayer implements Layer {
  private readonly script: TokenizedScript;
  private readonly tracker: ScriptTracker;
  private lines: LayoutLine[] | null = null;
  /** Line index of each word (parallel to script.words). */
  private wordLines: number[] = [];
  private layoutKey = "";
  private firstLine = 0;
  /** True after the tracker moved: the next paint re-centers on the position. */
  private autoScrollPending = true;
  private tracking = true;
  private status = "";
  private unsubscribeTranscript: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  // Geometry from the last paint, for the input handlers.
  private visibleRows = 10;
  private anchorRow = 3;

  constructor(
    text: string,
    private readonly title: string,
    private readonly hooks: ReaderHooks,
    initialPosition = 0,
  ) {
    this.script = tokenizeScript(text);
    this.tracker = new ScriptTracker(this.script.words);
    this.tracker.anchor(initialPosition);
  }

  /** Start listening. Called once the layer is on its stack. */
  attach(): void {
    this.unsubscribeStatus = voiceControlBridge.onStatus((state) => {
      this.status = state.status;
      this.hooks.requestRender();
    });
    this.startTracking();
  }

  onRemoved(): void {
    this.hooks.savePosition(this.resumePosition());
    this.stopTracking();
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
  }

  get position(): number {
    return this.tracker.position;
  }

  buildMenuItems(): MenuItem[] {
    return [
      {
        label: this.tracking ? "Pause voice tracking" : "Resume voice tracking",
        onSelect: (ctx) => {
          this.toggleTracking();
          ctx.stack.pop();
        },
      },
      {
        label: "Restart from the top",
        onSelect: (ctx) => {
          this.tracker.anchor(0);
          this.firstLine = 0;
          this.autoScrollPending = true;
          ctx.stack.pop();
        },
      },
    ];
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultMediumFont();
    const smallFont = getDefaultSmallFont();
    const step = lineStep(font);
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);

    const footerY = height - smallFont.lineHeight - 4;
    this.visibleRows = Math.max(1, Math.floor((footerY - FOOTER_GAP - BODY_TOP) / step));
    this.anchorRow = Math.floor(this.visibleRows / 3);
    const lines = this.layout(font, width - 2 * MARGIN_X);

    if (this.autoScrollPending) {
      this.autoScrollPending = false;
      this.firstLine = this.clampFirstLine(this.lineOfPosition() - this.anchorRow);
    } else {
      this.firstLine = this.clampFirstLine(this.firstLine);
    }

    const position = this.tracker.position;
    const nextToken = position < this.script.words.length ? this.script.wordTokens[position]! : this.script.tokens.length;
    const lastLine = Math.min(lines.length, this.firstLine + this.visibleRows);
    for (let lineIndex = this.firstLine; lineIndex < lastLine; lineIndex++) {
      const y = BODY_TOP + (lineIndex - this.firstLine) * step;
      for (const span of lines[lineIndex]!.spans) {
        const isNext = span.tokenIndex === nextToken;
        const value = isNext ? NEXT_VALUE : span.tokenIndex < nextToken ? PAST_VALUE : UPCOMING_VALUE;
        image.drawText(font, MARGIN_X + span.x, y, span.text, value);
        if (isNext) {
          image.fillRect(MARGIN_X + span.x, y + font.lineHeight - 2, span.width, 2, NEXT_VALUE);
        }
      }
    }

    this.paintFooter(image, smallFont, width, footerY);
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    switch (event.type) {
      case "scroll-down":
        this.scrollBy(SCROLL_STEP_LINES);
        return;
      case "scroll-up":
        this.scrollBy(-SCROLL_STEP_LINES);
        return;
      case "click":
        this.toggleTracking();
        return;
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }

  private paintFooter(image: GrayImage, font: UiFont, width: number, y: number): void {
    const total = this.script.words.length;
    const percent = total === 0 ? 0 : Math.round((100 * this.tracker.position) / total);
    const right = `${this.tracking ? this.status || "Listening" : "Paused"}   ${percent}%`;
    const rightWidth = font.measureText(right);
    image.drawText(font, width - MARGIN_X - rightWidth, y, right, 110);
    const titleMax = width - 2 * MARGIN_X - rightWidth - 12;
    if (titleMax > 20) {
      image.drawText(font, MARGIN_X, y, truncateText(font, this.title, titleMax), 110);
    }
  }

  /**
   * Hand-scroll by whole lines. The tracker is re-anchored to the first word
   * at (or after) the anchor row, so the highlight follows the view and
   * speech matching resumes from there.
   */
  private scrollBy(deltaLines: number): void {
    const lines = this.lines;
    if (!lines) return;
    this.autoScrollPending = false;
    this.firstLine = this.clampFirstLine(this.firstLine + deltaLines);
    const anchorLine = this.firstLine + this.anchorRow;
    const word = this.firstWordAtOrAfterLine(anchorLine);
    this.tracker.anchor(word);
  }

  private clampFirstLine(value: number): number {
    const lineCount = this.lines?.length ?? 0;
    // Scroll far enough that the last line can reach the anchor row.
    return clamp(value, 0, Math.max(0, lineCount - this.anchorRow - 1));
  }

  private lineOfPosition(): number {
    const position = this.tracker.position;
    if (this.wordLines.length === 0) return 0;
    if (position >= this.wordLines.length) return this.wordLines[this.wordLines.length - 1]!;
    return this.wordLines[position]!;
  }

  private firstWordAtOrAfterLine(line: number): number {
    for (let word = 0; word < this.wordLines.length; word++) {
      if (this.wordLines[word]! >= line) return word;
    }
    return this.wordLines.length;
  }

  /** Where to resume next time: a script read to the end restarts from the top. */
  private resumePosition(): number {
    return this.tracker.position >= this.script.words.length ? 0 : this.tracker.position;
  }

  private toggleTracking(): void {
    if (this.tracking) {
      this.stopTracking();
      this.hooks.savePosition(this.resumePosition());
    } else {
      this.startTracking();
    }
  }

  private startTracking(): void {
    this.tracking = true;
    if (!this.unsubscribeTranscript) {
      this.unsubscribeTranscript = voiceControlBridge.onTranscript((event) => this.onTranscript(event));
    }
    this.hooks.startCapture();
  }

  private stopTracking(): void {
    this.tracking = false;
    this.unsubscribeTranscript?.();
    this.unsubscribeTranscript = null;
    this.hooks.stopCapture();
  }

  private onTranscript(event: VoiceTranscriptEvent): void {
    if (!this.tracking) return;
    if (this.tracker.feed(event.text)) {
      this.autoScrollPending = true;
      this.hooks.requestRender();
    }
  }

  /** Word-by-word greedy line layout; cached per font and width. */
  private layout(font: UiFont, maxWidth: number): LayoutLine[] {
    const key = `${font.fingerprintId}:${maxWidth}`;
    if (this.lines && this.layoutKey === key) return this.lines;
    const spaceWidth = font.measureText(" ");
    const lines: LayoutLine[] = [];
    const wordLines: number[] = [];
    let current: LayoutLine = { spans: [] };
    let currentWidth = 0;
    let paragraph = -1;
    const flush = () => {
      lines.push(current);
      current = { spans: [] };
      currentWidth = 0;
    };
    for (let tokenIndex = 0; tokenIndex < this.script.tokens.length; tokenIndex++) {
      const token = this.script.tokens[tokenIndex]!;
      if (token.paragraph !== paragraph) {
        // New paragraph: end the current line, and leave one empty line per
        // blank source line (paragraph numbers count every newline).
        if (paragraph >= 0) {
          flush();
          for (let blank = paragraph + 1; blank < token.paragraph; blank++) flush();
        }
        paragraph = token.paragraph;
      }
      const wordWidth = font.measureText(token.text);
      const x = current.spans.length === 0 ? 0 : currentWidth + spaceWidth;
      if (current.spans.length > 0 && x + wordWidth > maxWidth) {
        flush();
      }
      const spanX = current.spans.length === 0 ? 0 : currentWidth + spaceWidth;
      current.spans.push({ tokenIndex, x: spanX, width: wordWidth, text: token.text });
      currentWidth = spanX + wordWidth;
      if (token.wordIndex >= 0) {
        wordLines[token.wordIndex] = lines.length;
      }
    }
    if (current.spans.length > 0 || lines.length === 0) flush();
    this.lines = lines;
    this.wordLines = wordLines;
    this.layoutKey = key;
    return lines;
  }
}
