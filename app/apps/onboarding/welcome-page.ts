import type { GrayImage, UiFont } from "../../graphics/image";
import { getFullLogo } from "../../graphics/logo";
import { wrapText } from "../../graphics/textwrap";
import type { InputEvent } from "../../ui/gestures";
import { FACECLAW_VERSION } from "../../version";
import { onboardingFont } from "./onboarding-fonts";
import { PAGE_X, type OnboardingNav, type OnboardingPage } from "./onboarding-page";

const LOGO_MAX_HEIGHT = 180;
const LOGO_MARGIN = 12;
const LOGO_TEXT_GAP = 28;
const PROMPT_GAP = 22;
const PROMPT = "Tap the ring or touchpad to continue";

type TextLine = { font: UiFont; text: string; value: number; spaceBefore: number };

/** The splash: logo beside the name, version and how to go on, centred as one group. */
export class WelcomePage implements OnboardingPage {
  paint(image: GrayImage): void {
    const { width, height } = image;
    const logo = getFullLogo(Math.min(LOGO_MAX_HEIGHT, height - 2 * LOGO_MARGIN));
    const logoWidth = logo ? logo.width + LOGO_TEXT_GAP : 0;
    const body = onboardingFont("body");
    const lines: TextLine[] = [
      { font: onboardingFont("hero"), text: "Faceclaw", value: 240, spaceBefore: 0 },
      { font: body, text: `Version ${FACECLAW_VERSION}`, value: 150, spaceBefore: 0 },
      ...wrapText(body, PROMPT, width - 2 * PAGE_X - logoWidth).map((text, index) => ({
        font: body,
        text,
        value: 215,
        spaceBefore: index === 0 ? PROMPT_GAP : 0,
      })),
    ];
    const textWidth = Math.max(...lines.map((line) => line.font.measureText(line.text)));
    const textHeight = lines.reduce((total, line) => total + line.spaceBefore + line.font.lineHeight, 0);
    const left = Math.max(PAGE_X, Math.round((width - logoWidth - textWidth) / 2));
    if (logo) {
      image.bitBlt(logo, left, Math.round((height - logo.height) / 2), { transparentZero: true });
    }
    let y = Math.round((height - textHeight) / 2);
    for (const line of lines) {
      y += line.spaceBefore;
      image.drawText(line.font, left + logoWidth, y, line.text, line.value);
      y += line.font.lineHeight;
    }
  }

  handleInput(event: InputEvent, nav: OnboardingNav): void {
    if (event.type === "click") nav.next();
  }
}
