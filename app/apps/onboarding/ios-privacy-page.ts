import { IOS_PRIVACY_NOTICE } from "../../analytics/privacy-disclosure";
import type { GrayImage } from "../../graphics/image";
import { wrapText } from "../../graphics/textwrap";
import type { InputEvent } from "../../ui/gestures";
import { onboardingFont } from "./onboarding-fonts";
import { drawPageHeading, PAGE_X, type OnboardingNav, type OnboardingPage } from "./onboarding-page";

/** Paginate the notice so no disclosure is silently clipped on a short glasses viewport. */
export class IosPrivacyPage implements OnboardingPage {
  private page = 0;
  private pageCount = 1;

  enter(): void { this.page = 0; }

  paint(image: GrayImage): void {
    const top = drawPageHeading(image, "iOS / TestFlight privacy", "") + 8;
    const font = onboardingFont("detail");
    const lines = IOS_PRIVACY_NOTICE.split("\n\n").flatMap((paragraph, index) => [
      ...(index ? [""] : []), ...wrapText(font, paragraph, image.width - 2 * PAGE_X),
    ]);
    const perPage = Math.max(1, Math.floor((image.height - top - font.lineHeight - 20) / font.lineHeight));
    this.pageCount = Math.ceil(lines.length / perPage);
    this.page = Math.min(this.page, this.pageCount - 1);
    lines.slice(this.page * perPage, (this.page + 1) * perPage).forEach((line, index) => {
      image.drawText(font, PAGE_X, top + index * font.lineHeight, line, 200);
    });
    const action = this.page + 1 < this.pageCount ? "Tap for more" : "Tap to choose statistics";
    image.drawText(font, PAGE_X, image.height - font.lineHeight - 8,
      `${this.page + 1}/${this.pageCount} - ${action}`, 230);
  }

  handleInput(event: InputEvent, nav: OnboardingNav): void {
    if (event.type === "click") {
      if (this.page + 1 < this.pageCount) this.page++;
      else nav.next();
    } else if (event.type === "scroll-down" || event.type === "swipe-up") {
      this.page = Math.min(this.page + 1, this.pageCount - 1);
    } else if (event.type === "scroll-up" || event.type === "swipe-down") {
      this.page = Math.max(0, this.page - 1);
    }
  }
}
