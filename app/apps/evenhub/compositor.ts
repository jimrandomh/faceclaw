/**
 * Phone-side reimplementation of the on-glasses EvenHub page compositor:
 * containers render into the 576x288 canvas the stock firmware gives apps.
 *
 * Text uses Even's extracted 20px firmware font (via EvenHubFont), measured
 * and wrapped with @evenrealities/pretext, so glyph widths and line breaks
 * match what apps expect. Extended layouts may pick other fonts per container
 * (fonts.ts), which wrap with Faceclaw's own text wrapping.
 *
 * Containers stack in stock's order (paintOrder): without zOrderIndex, lists,
 * then texts, then images, so an image container covers text beneath it. Text
 * containers are transparent windows that clip their text and scroll it.
 *
 * Known deviations from stock, acceptable for now:
 *  - List rendering is a plain vertical list. A non-zero itemWidth sets the
 *    selection outline's width and truncates long items to fit, as on stock;
 *    whether stock also lays narrow items out side by side is unknown.
 *  - Lists scroll with our menus' animation and bounce (see list-menu.ts).
 *  - Text scrolls in jumps; stock eases each 28px step over 200ms and
 *    rubber-bands at the ends.
 */
import { GrayImage } from "../../graphics/image";
import { containerFace } from "./fonts";
import {
  borderGrey,
  paintOrder,
  type EvenHubImageContainer,
  type EvenHubListContainer,
  type EvenHubPage,
  type EvenHubTextContainer,
} from "./containers";
import { paintListItems } from "./list-menu";

export const EVENHUB_SCREEN_WIDTH = 576;
export const EVENHUB_SCREEN_HEIGHT = 288;

const TEXT_WHITE = 255;

/**
 * SDK 0.0.14 textColor levels 0..4 as the greys stock draws them (measured
 * in the firmware emulator): level 0 is dim, not off. A missing or
 * out-of-range level draws white, the only colour before 0.0.14.
 */
const TEXT_BRIGHTNESS_GREYS = [51, 102, 153, 204, 255];

function textGrey(level: number | undefined): number {
  return level === undefined ? TEXT_WHITE : (TEXT_BRIGHTNESS_GREYS[level] ?? TEXT_WHITE);
}

/**
 * The scrollbar stock draws on any text container whose text overflows
 * (LV_SCROLLBAR_MODE_AUTO), whether or not it captures input: 4px wide, 10px
 * in from the right edge, in a track 6px in from top and bottom, with its
 * corner pixels cut. Measured in the firmware emulator.
 */
const SCROLLBAR_GREY = 187;
const SCROLLBAR_WIDTH = 4;
const SCROLLBAR_RIGHT_INSET = 10;
const SCROLLBAR_TRACK_INSET = 6;

type Rect = { x: number; y: number; width: number; height: number };

/** A text container's wrapped lines and the geometry its scrolling works in. */
export type TextLayout = {
  lines: string[];
  lineHeight: number;
  /** Left edge and unscrolled top of the text. */
  contentX: number;
  contentY: number;
  /** Height of the window the text scrolls in (inside border and padding). */
  viewportHeight: number;
  /** Largest scrollY: how far the text overflows that window. */
  maxScroll: number;
};

/**
 * Stock lays text out at x + border + padding and wraps it at width - 2 *
 * padding: the label is sized ignoring the border, so a line can run into
 * the right border, where it is clipped.
 */
export function layoutText(container: EvenHubTextContainer): TextLayout {
  const inset = container.borderWidth + container.paddingLength;
  const face = containerFace(container.font);
  const lines = face.wrap(container.content, Math.max(1, container.width - 2 * container.paddingLength));
  const viewportHeight = Math.max(0, container.height - 2 * inset);
  return {
    lines,
    lineHeight: face.lineHeight,
    contentX: container.x + inset,
    contentY: container.y + inset,
    viewportHeight,
    maxScroll: Math.max(0, lines.length * face.lineHeight - viewportHeight),
  };
}

/**
 * Text is clipped at the border's inner edge (at the container's edge when it
 * has no border). Lines wholly inside stay deferred firmware-text draws; a
 * line the edge cuts is rasterized and blitted clipped. Chars the font lacks
 * are skipped silently, as on stock (no tofu).
 */
function paintTextContainer(image: GrayImage, container: EvenHubTextContainer): void {
  // Only the text dims: textColor is a text-brightness level; the border has its own color.
  paintBorder(image, container);
  const layout = layoutText(container);
  const face = containerFace(container.font);
  const grey = textGrey(container.textColor);
  const border = container.borderWidth;
  const clip: Rect = {
    x: container.x + border,
    y: container.y + border,
    width: Math.max(0, container.width - 2 * border),
    height: Math.max(0, container.height - 2 * border),
  };
  for (let i = 0; i < layout.lines.length; i++) {
    const y = layout.contentY + i * layout.lineHeight - container.scrollY;
    const bottom = y + layout.lineHeight;
    if (bottom <= clip.y || y >= clip.y + clip.height) continue;
    const line = layout.lines[i]!;
    if (y >= clip.y && bottom <= clip.y + clip.height && layout.contentX + face.measureLine(line) <= clip.x + clip.width) {
      face.drawText(image, layout.contentX, y, line, grey);
      continue;
    }
    const strip = new GrayImage(container.width, layout.lineHeight, 0);
    face.drawText(strip, layout.contentX - container.x, 0, line, grey);
    const visibleTop = Math.max(y, clip.y);
    image.bitBlt(strip.withDrawsBaked(), clip.x, visibleTop, {
      sx: clip.x - container.x,
      sy: visibleTop - y,
      width: clip.width,
      height: Math.min(bottom, clip.y + clip.height) - visibleTop,
      transparentZero: true,
    });
  }
  if (layout.maxScroll > 0) paintScrollbar(image, container, layout);
}

function paintScrollbar(image: GrayImage, container: EvenHubTextContainer, layout: TextLayout): void {
  const height = container.height;
  const track = height - 2 * SCROLLBAR_TRACK_INSET;
  const length = Math.floor((track * height) / (height + layout.maxScroll));
  if (track <= 0 || length <= 0) return;
  const top = container.y + SCROLLBAR_TRACK_INSET + Math.floor(((track - length) * container.scrollY) / layout.maxScroll);
  const left = container.x + container.width - SCROLLBAR_RIGHT_INSET;
  for (let row = 0; row < length; row++) {
    const end = row === 0 || row === length - 1;
    image.fillRect(end ? left + 1 : left, top + row, end ? SCROLLBAR_WIDTH - 2 : SCROLLBAR_WIDTH, 1, SCROLLBAR_GREY);
  }
}

function paintBorder(
  image: GrayImage,
  container: { x: number; y: number; width: number; height: number; borderWidth: number; borderColor: number; borderRadius: number },
): void {
  const grey = borderGrey(container.borderColor);
  for (let i = 0; i < container.borderWidth; i++) {
    if (container.borderRadius > 0) {
      image.drawRoundedRect(
        container.x + i,
        container.y + i,
        container.width - 2 * i,
        container.height - 2 * i,
        grey,
        Math.max(0, container.borderRadius - i),
      );
    } else {
      image.drawRect(container.x + i, container.y + i, container.width - 2 * i, container.height - 2 * i, grey);
    }
  }
}

/**
 * An opaque bitmap (black pixels cover what's beneath). Updates are converted
 * to exactly the container's size (image-pipeline.ts); pixels an extended
 * layout carried over from a differently sized container are clipped.
 */
function paintImageContainer(image: GrayImage, container: EvenHubImageContainer): void {
  if (!container.pixels || container.pixelsWidth <= 0 || container.pixelsHeight <= 0) return;
  const source = new GrayImage(container.pixelsWidth, container.pixelsHeight, 0);
  source.pixels.set(container.pixels);
  image.bitBlt(source, container.x, container.y, {
    width: Math.min(container.pixelsWidth, container.width),
    height: Math.min(container.pixelsHeight, container.height),
  });
}

function paintListContainer(image: GrayImage, container: EvenHubListContainer, focused: boolean): void {
  paintBorder(image, container);
  paintListItems(image, container, containerFace(container.font), focused);
}

/** Render a page into a fresh app-viewport image (positioned by the shell). */
export function compositePage(page: EvenHubPage | null, size: { width: number; height: number }, focused: boolean): GrayImage {
  const image = new GrayImage(size.width, size.height, 0);
  if (!page) return image;
  for (const container of paintOrder(page.containers)) {
    switch (container.kind) {
      case "image": {
        if (!container.pixels) break; // Nothing is drawn before the first update.
        // Text painted so far is deferred draws (firmware-text runs), which
        // would otherwise render above this container's raster. The image is
        // opaque and covers what's under it, so bake the draws it overlaps
        // first; the others, and text painted later, stay deferred.
        const box: Rect = { x: container.x, y: container.y, width: container.width, height: container.height };
        image.bakeDeferredDrawsWithin(box);
        paintImageContainer(image, container);
        break;
      }
      case "text":
        paintTextContainer(image, container);
        break;
      case "list":
        paintListContainer(image, container, focused);
        break;
    }
  }
  return image;
}
