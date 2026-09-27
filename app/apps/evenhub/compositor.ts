/**
 * Phone-side reimplementation of the on-glasses EvenHub page compositor:
 * containers render into the 576x288 canvas the stock firmware gives apps.
 *
 * Text uses Even's extracted 20px firmware font (via EvenHubFont), measured
 * and wrapped with @evenrealities/pretext, so glyph widths and line breaks
 * match what apps expect.
 *
 * Known deviations from stock, acceptable for now:
 *  - List rendering is a plain vertical list. A non-zero itemWidth sets the
 *    selection outline's width and truncates long items to fit, as on stock;
 *    whether stock also lays narrow items out side by side is unknown.
 *  - Lists scroll with our menus' animation and bounce (see list-menu.ts).
 */
import { GrayImage } from "../../graphics/image";
import { EvenHubFont } from "../../graphics/evenhub-font";
import {
  type EvenHubContainer,
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
 * SDK 0.0.14 textColor levels 0..4 as grey values. Level 4 is the default and
 * the only one apps got before 0.0.14, so it must stay exactly TEXT_WHITE.
 * Level 0 is the firmware's "fully dim" step, which over the black page
 * background means the text is effectively not shown.
 */
const TEXT_BRIGHTNESS_GREYS = [0, 64, 128, 191, 255];

function textGrey(level: number | undefined): number {
  return level === undefined ? TEXT_WHITE : (TEXT_BRIGHTNESS_GREYS[level] ?? TEXT_WHITE);
}

/** Chars the font lacks are skipped silently on stock (no tofu); EvenHubFont
 * skips unknown glyphs, matching that. */
function paintTextContainer(image: GrayImage, container: EvenHubTextContainer): void {
  // Only the text dims: textColor is a text-brightness level, and stock draws
  // the container's border at full brightness regardless.
  paintBorder(image, container);
  const inset = container.borderWidth + container.paddingLength;
  EvenHubFont.get().drawTextWrapped(
    image,
    container.x + inset,
    container.y + inset,
    Math.max(1, container.width - 2 * inset),
    container.content,
    textGrey(container.textColor),
  );
}

function paintBorder(
  image: GrayImage,
  container: { x: number; y: number; width: number; height: number; borderWidth: number; borderRadius: number },
): void {
  for (let i = 0; i < container.borderWidth; i++) {
    if (container.borderRadius > 0) {
      image.drawRoundedRect(
        container.x + i,
        container.y + i,
        container.width - 2 * i,
        container.height - 2 * i,
        TEXT_WHITE,
        Math.max(0, container.borderRadius - i),
      );
    } else {
      image.drawRect(container.x + i, container.y + i, container.width - 2 * i, container.height - 2 * i, TEXT_WHITE);
    }
  }
}

function paintImageContainer(image: GrayImage, container: EvenHubImageContainer): void {
  if (!container.pixels || container.pixelsWidth <= 0 || container.pixelsHeight <= 0) return;
  const source = new GrayImage(container.pixelsWidth, container.pixelsHeight, 0);
  source.pixels.set(container.pixels);
  // Stock quirk: raw data smaller than the container tiles/repeats to fill it.
  for (let ty = 0; ty < container.height; ty += container.pixelsHeight) {
    for (let tx = 0; tx < container.width; tx += container.pixelsWidth) {
      image.bitBlt(source, container.x + tx, container.y + ty, {
        width: Math.min(container.pixelsWidth, container.width - tx),
        height: Math.min(container.pixelsHeight, container.height - ty),
      });
    }
  }
}

function paintListContainer(image: GrayImage, container: EvenHubListContainer, focused: boolean): void {
  paintBorder(image, container);
  paintListItems(image, container, EvenHubFont.get(), focused);
}

/** Bottom-to-top paint order for a page's containers. */
function paintOrder(containers: EvenHubContainer[]): EvenHubContainer[] {
  const anyZ = containers.some((c) => c.zOrderIndex !== undefined);
  if (anyZ) {
    // Explicit z-order: larger zOrderIndex renders closer to the front, i.e.
    // painted later. (Stock requires all-or-nothing + unique values.)
    return [...containers].sort((a, b) => (a.zOrderIndex ?? 0) - (b.zOrderIndex ?? 0));
  }
  // Default (no z-order): image containers sit below lists and text. Cross-type
  // order isn't defined by the wire format (separate object arrays), so this is
  // our choice, matching stock. Order within each group is preserved.
  const images = containers.filter((c) => c.kind === "image");
  const rest = containers.filter((c) => c.kind !== "image");
  return [...images, ...rest];
}

/** Render a page into a fresh app-viewport image (positioned by the shell). */
export function compositePage(page: EvenHubPage | null, size: { width: number; height: number }, focused: boolean): GrayImage {
  const image = new GrayImage(size.width, size.height, 0);
  if (!page) return image;
  for (const container of paintOrder(page.containers)) {
    switch (container.kind) {
      case "image":
        // Text painted so far is deferred draws (firmware-text runs), which
        // would otherwise render above this container's raster. Stock puts a
        // later image container OVER earlier text, so bake the pending draws
        // first; text painted after this container stays deferred (and above).
        image.bakeDeferredDrawsInPlace();
        paintImageContainer(image, container);
        break;
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
