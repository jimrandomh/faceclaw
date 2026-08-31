import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { truncateText } from "../../graphics/textwrap";
import { canLoadFontFile, fontFileDisplayName, fontFileMetrics, renderFontFileText, renderFontFileWrapped } from "../../native/font-files";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_SCROLL, gestureHints, type InputEvent } from "../../ui/gestures";
import { Layer, type LayerContext } from "../../ui/layers";

const MARGIN_X = 18;
const TITLE_Y = 8;
const BODY_TOP = 26;
const FOOTER_MARGIN = 20;
const SAMPLE_GAP = 4;

const SIZES = [8,9,10,11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 40, 48] as const;
const DEFAULT_SIZE_INDEX = SIZES.indexOf(16);
// 1.0 = linear coverage->shade mapping, which should match the G2's
// roughly-linear display response; the darker/brighter options are for
// on-hardware comparison. Cycled with click.
const GAMMAS = [1.0, 1.3, 1.6, 0.7, 0.5] as const;

const PANGRAM = "The quick brown fox jumps over the lazy dog.";
const CHARSET = "AaBbGgRr 0123456789 ?!&%().,;:'\"";
const PARAGRAPH =
  "Weather for today: partly cloudy, high of 23°C with a light breeze. " +
  "Meeting with Sam moved to 14:30 — they asked if you can review the " +
  "draft first. Battery 78%.";

/**
 * Font previewer for a font file on disk (TTF/OTF/TTC), rendered through the
 * Android text stack: a single-line pangram, a character-set sample, and a
 * wrapped paragraph, all at an adjustable pixel size. Scroll changes size,
 * click cycles the coverage gamma (for judging antialiasing on the lens),
 * double-click closes. Sized to its hosting stack (a Files document window,
 * or pushed over the file browser for view-in-place).
 */
export class FontPreviewerLayer implements Layer {
  private sizeIndex = DEFAULT_SIZE_INDEX >= 0 ? DEFAULT_SIZE_INDEX : 2;
  private gammaIndex = 0;
  private loadable: boolean | null = null;
  private displayName: string | null = null;
  /** Rendered samples for the current size+gamma, keyed by sample id. */
  private readonly cache = new Map<string, GrayImage | null>();

  constructor(
    private readonly path: string,
    private readonly fileName: string,
  ) {}

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const out = new GrayImage(width, height, 0);
    const size = SIZES[this.sizeIndex]!;
    const gamma = GAMMAS[this.gammaIndex]!;

    const status = `${size}px  γ ${gamma.toFixed(1)}`;
    const statusWidth = font.measureText(status);
    const title = truncateText(font, this.getDisplayName(), width - 2 * MARGIN_X - statusWidth - 12);
    out.drawText(font, MARGIN_X, TITLE_Y, title, 220);
    out.drawText(font, width - MARGIN_X - statusWidth, TITLE_Y, status, 150);

    if (this.loadable === null) {
      this.loadable = canLoadFontFile(this.path);
    }
    const footerY = height - FOOTER_MARGIN;
    if (!this.loadable) {
      out.drawText(font, MARGIN_X, BODY_TOP + 16, "(could not load font)", 160);
      out.drawText(font, MARGIN_X, footerY, gestureHints([[GESTURE_DOUBLE_CLICK, "back"]]), 110);
      return out;
    }

    const bodyWidth = width - 2 * MARGIN_X;
    let y = BODY_TOP;
    for (const [id, text] of [
      ["pangram", PANGRAM],
      ["charset", CHARSET],
    ] as const) {
      const line = this.getCached(id, () => renderFontFileText(this.path, text, size, gamma));
      if (!line) continue;
      out.bitBlt(line, MARGIN_X, y, { width: bodyWidth });
      y += line.height + SAMPLE_GAP;
    }

    // Fill the rest with a wrapped paragraph, however many lines fit.
    const metrics = fontFileMetrics(this.path, size);
    const lineHeight = metrics ? metrics.ascent + metrics.descent + metrics.lineGap : size;
    const paragraphLines = Math.floor((footerY - SAMPLE_GAP - y) / Math.max(1, lineHeight));
    if (paragraphLines >= 1) {
      const paragraph = this.getCached(`para:${paragraphLines}:${bodyWidth}`, () =>
        renderFontFileWrapped({
          path: this.path,
          text: PARAGRAPH,
          sizePx: size,
          maxWidth: bodyWidth,
          maxLines: paragraphLines,
          gamma,
        }),
      );
      if (paragraph) {
        out.bitBlt(paragraph, MARGIN_X, y + SAMPLE_GAP);
      }
    }

    out.drawText(
      font,
      MARGIN_X,
      footerY,
      gestureHints([
        [GESTURE_SCROLL, "size"],
        [GESTURE_CLICK, "gamma"],
        [GESTURE_DOUBLE_CLICK, "back"],
      ]),
      110,
    );
    return out;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    switch (event.type) {
      case "scroll-up":
        this.setSizeIndex(this.sizeIndex + 1);
        return;
      case "scroll-down":
        this.setSizeIndex(this.sizeIndex - 1);
        return;
      case "click":
        this.gammaIndex = (this.gammaIndex + 1) % GAMMAS.length;
        this.cache.clear();
        return;
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }

  private setSizeIndex(index: number): void {
    const clamped = Math.max(0, Math.min(SIZES.length - 1, index));
    if (clamped !== this.sizeIndex) {
      this.sizeIndex = clamped;
      this.cache.clear();
    }
  }

  private getCached(key: string, render: () => GrayImage | null): GrayImage | null {
    if (!this.cache.has(key)) {
      this.cache.set(key, render());
    }
    return this.cache.get(key) ?? null;
  }

  private getDisplayName(): string {
    if (this.displayName === null) {
      const name = fontFileDisplayName(this.path);
      this.displayName = name
        ? name.style && !/^regular$/i.test(name.style)
          ? `${name.family} ${name.style}`
          : name.family
        : this.fileName;
    }
    return this.displayName;
  }
}
