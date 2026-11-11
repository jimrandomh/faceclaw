import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { truncateText } from "../../graphics/textwrap";
import { GrayImage } from "../../graphics/image";
import { loadImageFileAsGray, PHOTO_TONE } from "../../native/image-files";
import { GESTURE_DOUBLE_CLICK, type InputEvent } from "../../ui/gestures";
import { Layer, type LayerContext } from "../../ui/layers";

/** From the title's top to the image area's. */
const TITLE_BAND = 16;
/** How far the image area keeps from the window's sides and bottom. */
const BODY_MARGIN = 2;

/**
 * Image viewer for a file on disk: title line, then the image decoded to
 * grayscale with the shared photo tone (sRGB gamma, dithered onto the 16
 * display levels) and downscaled to fit the remaining area (never
 * upscaled). Double-click closes it. Sized to its hosting stack (a Files document
 * window, or pushed over the file browser for view-in-place).
 */
export class ImageViewerLayer implements Layer {
  private image: GrayImage | null = null;
  /** The image area ("WxH") the file was last decoded to fit; null before the first load. */
  private fittedTo: string | null = null;

  constructor(
    private readonly path: string,
    private readonly title: string,
  ) {}

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height, padding } = ctx.stack.getBaseSize();
    const out = new GrayImage(width, height, 0);
    // The title line keeps inside the padding suggested for the window's
    // edges; the image fills the rest of the window whatever its edges touch.
    out.drawText(font, padding.left, padding.top, truncateText(font, this.title, width - padding.left - padding.right), 220);

    const bodyTop = padding.top + TITLE_BAND;
    const bodyWidth = width - 2 * BODY_MARGIN;
    const bodyHeight = height - bodyTop - BODY_MARGIN;
    // The area moves with the window's size and its top padding, so the
    // file is decoded again whenever it changes rather than once.
    const fit = `${bodyWidth}x${bodyHeight}`;
    if (this.fittedTo !== fit) {
      this.fittedTo = fit;
      this.image = loadImageFileAsGray(this.path, bodyWidth, bodyHeight, PHOTO_TONE);
    }
    if (!this.image) {
      out.drawText(font, padding.left, bodyTop + 16, "(could not load image)", 160);
      out.drawText(font, padding.left, height - padding.bottom - font.lineHeight, `${GESTURE_DOUBLE_CLICK} back`, 110);
      return out;
    }
    out.bitBlt(
      this.image,
      Math.round((width - this.image.width) / 2),
      bodyTop + Math.round((bodyHeight - this.image.height) / 2),
    );
    return out;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") {
      ctx.stack.pop();
    }
  }
}
