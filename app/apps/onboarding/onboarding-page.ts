import type { GrayImage } from "../../graphics/image";
import { wrapText } from "../../graphics/textwrap";
import type { InputEvent } from "../../ui/gestures";
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
  /** The page became current, going forward or back. */
  enter?(): void;
  paint(image: GrayImage, focused: boolean): void;
  handleInput(event: InputEvent, nav: OnboardingNav): void | Promise<void>;
}

/** Left margin and title position shared by the pages (the UI-wide (18, 10) title spot). */
export const PAGE_X = 18;
export const TITLE_Y = 10;

/**
 * Draw a page's title and its wrapped explanation (at most `maxLines`
 * lines) in the onboarding fonts. Returns the y just below the explanation.
 */
export function drawPageHeading(
  image: GrayImage,
  title: string,
  explanation: string,
  maxLines = 2,
): number {
  const titleFont = onboardingFont("title");
  const detailFont = onboardingFont("detail");
  image.drawText(titleFont, PAGE_X, TITLE_Y, title, 230);
  let y = TITLE_Y + titleFont.lineHeight + 2;
  const lines = wrapText(detailFont, explanation, image.width - 2 * PAGE_X).slice(0, maxLines);
  for (const line of lines) {
    image.drawText(detailFont, PAGE_X, y, line, 160);
    y += detailFont.lineHeight;
  }
  return y;
}
