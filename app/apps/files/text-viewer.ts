import { wrapText, truncateText } from "../../graphics/textwrap";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { TtfFont } from "../../graphics/ttf-font";
import { GrayImage, type UiFont } from "../../graphics/image";
import { type InputEvent } from "../../ui/gestures";
import { Layer, type LayerContext } from "../../ui/layers";

const MARGIN_X = 18;
const TITLE_Y = 16;
const BODY_X = 18;
const BODY_Y = 44;
const FOOTER_MARGIN = 36;

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
 * Paged text viewer for a document. Sized to its hosting stack (a Files
 * document window, or pushed over the file browser for view-in-place).
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
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const footerY = height - FOOTER_MARGIN;
    this.bodyLineCount = Math.max(1, Math.floor((footerY - BODY_Y) / lineStep));
    image.drawText(font, MARGIN_X + 4, TITLE_Y, truncateText(font, this.title, width - 2 * MARGIN_X - 8), 220);

    const lines = this.getLines(font, width);
    const visibleLines = lines.slice(this.firstLine, this.firstLine + this.bodyLineCount);
    for (let index = 0; index < visibleLines.length; index++) {
      image.drawText(font, BODY_X, BODY_Y + index * lineStep, visibleLines[index]!, 230);
    }

    const currentPage = Math.floor(this.firstLine / this.pageStep()) + 1;
    image.drawText(font, BODY_X, footerY, `Page ${currentPage}/${this.totalPageCount(lines.length)}`, 110);
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

  private getLines(font: UiFont, width: number): string[] {
    if (this.lines === null || this.wrappedForWidth !== width || this.wrappedWithFont !== font.fingerprintId) {
      const normalized = this.documentText.replace(/\t/g, "    ").replace(/\r/g, "");
      this.lines = wrapText(font, normalized, width - BODY_X - 12, {
        preserveLeadingWhitespace: true,
        breakLongWords: true,
      });
      this.wrappedForWidth = width;
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
