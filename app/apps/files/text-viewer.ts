import { wrapText, truncateText } from "../../graphics/textwrap";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { TtfFont } from "../../graphics/ttf-font";
import { GrayImage, type UiFont } from "../../graphics/image";
import { type InputEvent } from "../../ui/gestures";
import { Layer, type LayerContext } from "../../ui/layers";

/** The title: how far right of the body's column, and from its top to the first body line's. */
const TITLE_INSET_X = 4;
const TITLE_BAND = 28;

/** Line step for a bitmap face (the 12px font plus leading, as before). */
const BDF_LINE_STEP = 14;

/** Body text follows the UI font (a TTF by default; see ui-fonts.ts). */
function getViewerFont(): UiFont {
  return getDefaultSmallFont();
}

function lineStepOf(font: UiFont): number {
  return font instanceof TtfFont ? font.lineHeight : BDF_LINE_STEP;
}

/**
 * Paged text viewer for a document: a title line, the page's lines, and a
 * page-number line, all inside the padding suggested for the window's edges
 * (the title and page number stay put, so the lines page between them).
 * Sized to its hosting stack (a Files document window, or pushed over the
 * file browser for view-in-place).
 */
export class TextViewerLayer implements Layer {
  private lines: string[] | null = null;
  private wrappedForWidth = 0;
  private wrappedWithFont = 0;
  private firstLine = 0;
  private bodyLineCount = 14;

  constructor(
    private readonly documentText: string,
    private readonly title = "Text",
  ) {}

  paint(ctx: LayerContext): GrayImage {
    const font = getViewerFont();
    const lineStep = lineStepOf(font);
    const { width, height, padding } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const bodyX = padding.left;
    const bodyWidth = Math.max(0, width - padding.left - padding.right);
    const bodyY = padding.top + TITLE_BAND;
    const footerY = height - padding.bottom - font.lineHeight;
    this.bodyLineCount = Math.max(1, Math.floor((footerY - bodyY) / lineStep));
    image.drawText(font, bodyX + TITLE_INSET_X, padding.top, truncateText(font, this.title, bodyWidth - 2 * TITLE_INSET_X), 220);

    const lines = this.getLines(font, bodyWidth);
    const visibleLines = lines.slice(this.firstLine, this.firstLine + this.bodyLineCount);
    for (let index = 0; index < visibleLines.length; index++) {
      image.drawText(font, bodyX, bodyY + index * lineStep, visibleLines[index]!, 230);
    }

    const currentPage = Math.floor(this.firstLine / this.pageStep()) + 1;
    image.drawText(font, bodyX, footerY, `Page ${currentPage}/${this.totalPageCount(lines.length)}`, 110);
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    switch (event.type) {
      case "scroll-down":
        this.scrollBy(this.pageStep());
        return;
      case "scroll-up":
        this.scrollBy(-this.pageStep());
        return;
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }

  private pageStep(): number {
    return Math.max(1, this.bodyLineCount - 1);
  }

  private scrollBy(delta: number): void {
    const lines = this.lines ?? [];
    if (lines.length <= this.bodyLineCount) {
      this.firstLine = 0;
      return;
    }
    const maxFirstLine = Math.max(0, lines.length - 1);
    this.firstLine = Math.max(0, Math.min(maxFirstLine, this.firstLine + delta));
  }

  /** The document wrapped to the body column's width; cached per width and font. */
  private getLines(font: UiFont, bodyWidth: number): string[] {
    if (this.lines === null || this.wrappedForWidth !== bodyWidth || this.wrappedWithFont !== font.fingerprintId) {
      const normalized = this.documentText.replace(/\t/g, "    ").replace(/\r/g, "");
      this.lines = wrapText(font, normalized, bodyWidth, {
        preserveLeadingWhitespace: true,
        breakLongWords: true,
      });
      this.wrappedForWidth = bodyWidth;
      this.wrappedWithFont = font.fingerprintId;
    }
    return this.lines;
  }

  private totalPageCount(lineCount: number): number {
    if (lineCount <= this.bodyLineCount) {
      return 1;
    }
    return Math.ceil((lineCount - this.bodyLineCount) / this.pageStep()) + 1;
  }
}
