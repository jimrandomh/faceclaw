import type { GrayImage } from "../../graphics/image";
import { wrapText } from "../../graphics/textwrap";
import type { InputEvent } from "../../ui/gestures";
import type { Edges } from "../../ui/viewport";
import { onboardingFont } from "./onboarding-fonts";

/** Page-to-flow navigation, handed to a page's input handler. */
export type OnboardingNav = {
  /** Go to the next page, or finish onboarding from the last one. */
  next: () => void;
};

/**
 * One onboarding step. The flow owns the page list, back navigation
 * (double-click) and finishing; a page paints itself into the window's
 * viewport and handles every other gesture.
 */
export interface OnboardingPage {
  /**
   * Show the page immersive (full-screen): the whole 640×480 panel, with
   * the app switcher and status bar hidden. Otherwise it is an ordinary
   * window in the chosen layout.
   */
  readonly immersive?: boolean;
  /** Whether the page belongs in the flow right now; skipped both ways when false. */
  applies?(): boolean;
  /** The page became current, going forward or back. */
  enter?(): void;
  /**
   * Paint the page over the whole image, the window's viewport. `padding`
   * is the padding suggested for each of its edges (viewport.ts): none on an
   * immersive page, whose edges are the screen's.
   */
  paint(image: GrayImage, focused: boolean, padding: Edges<number>): void;
  handleInput(event: InputEvent, nav: OnboardingNav): void | Promise<void>;
}

/**
 * How far a page's text (its title and explanation, a list row's label)
 * sits inside the side padding. A list's selection boxes start at the
 * padding itself, so the title lines up with the rows' text.
 */
export const PAGE_TEXT_INSET = 10;
/** The title's drop below the top padding. */
const TITLE_OFFSET_Y = 2;

/**
 * The x that centres something `width` wide in the window, short of
 * entering either side's padding.
 */
export function centredX(image: GrayImage, padding: Edges<number>, width: number): number {
  return Math.max(padding.left, Math.min(image.width - padding.right - width, Math.round((image.width - width) / 2)));
}

/**
 * Draw a page's title and its wrapped explanation (at most `maxLines`
 * lines) in the onboarding fonts. Returns the y just below the explanation.
 */
export function drawPageHeading(
  image: GrayImage,
  padding: Edges<number>,
  title: string,
  explanation: string,
  maxLines = 2,
): number {
  const titleFont = onboardingFont("title");
  const detailFont = onboardingFont("detail");
  const x = padding.left + PAGE_TEXT_INSET;
  const textWidth = Math.max(0, image.width - padding.left - padding.right - 2 * PAGE_TEXT_INSET);
  const titleY = padding.top + TITLE_OFFSET_Y;
  image.drawText(titleFont, x, titleY, title, 230);
  let y = titleY + titleFont.lineHeight + 2;
  const lines = wrapText(detailFont, explanation, textWidth).slice(0, maxLines);
  for (const line of lines) {
    image.drawText(detailFont, x, y, line, 160);
    y += detailFont.lineHeight;
  }
  return y;
}
