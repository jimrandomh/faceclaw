import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { truncateText } from "../../graphics/textwrap";
import { canLoadFontFile, fontFileDisplayName, fontFileMetrics, renderFontFileText, renderFontFileWrapped } from "../../native/font-files";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_SCROLL, gestureHints, type InputEvent } from "../../ui/gestures";
import { Layer, type LayerContext } from "../../ui/layers";

/** From the title's top to the first sample's. */
const TITLE_BAND = 18;
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
 * native text stack: a single-line pangram, a character-set sample, and a
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
    const { width, height, padding } = ctx.stack.getBaseSize();
    const out = new GrayImage(width, height, 0);
    const size = SIZES[this.sizeIndex]!;
    const gamma = GAMMAS[this.gammaIndex]!;
    // Everything keeps inside the padding suggested for the window's edges:
    // the title line at the top, the samples across the width, the hint
    // line at the bottom.
    const left = padding.left;
    const bodyWidth = Math.max(0, width - padding.left - padding.right);
    const bodyTop = padding.top + TITLE_BAND;

    const status = `${size}px  γ ${gamma.toFixed(1)}`;
    const statusWidth = font.measureText(status);
    const title = truncateText(font, this.getDisplayName(), bodyWidth - statusWidth - 12);
    out.drawText(font, left, padding.top, title, 220);
    out.drawText(font, left + bodyWidth - statusWidth, padding.top, status, 150);

    if (this.loadable === null) {
      this.loadable = canLoadFontFile(this.path);
    }
    const footerY = height - padding.bottom - font.lineHeight;
    if (!this.loadable) {
      out.drawText(font, left, bodyTop + 16, "(could not load font)", 160);
      out.drawText(font, left, footerY, gestureHints([[GESTURE_DOUBLE_CLICK, "back"]]), 110);
      return out;
    }

    let y = bodyTop;
    for (const [id, text] of [
      ["pangram", PANGRAM],
      ["charset", CHARSET],
    ] as const) {
      const line = this.getCached(id, () => renderFontFileText(this.path, text, size, gamma));
      if (!line) continue;
      out.bitBlt(line, left, y, { width: bodyWidth });
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
        out.bitBlt(paragraph, left, y + SAMPLE_GAP);
      }
    }

    out.drawText(
      font,
      left,
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
