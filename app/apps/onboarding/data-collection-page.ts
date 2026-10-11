import type { GrayImage } from "../../graphics/image";
import { truncateText } from "../../graphics/textwrap";
import { dataCollectionSetting, dataCollectionSummary, type DataCollectionLevel } from "../../ui/dashboard-settings";
import type { InputEvent } from "../../ui/gestures";
import { Menu, type MenuDrawArgs } from "../../ui/menu-core";
import { LIST_ROW_TEXT_INSET, listRowHeight } from "../../ui/metrics";
import { onboardingFont } from "./onboarding-fonts";
import { drawPageHeading, PAGE_X, type OnboardingNav, type OnboardingPage } from "./onboarding-page";

const CONTENT_GAP = 10;
const BOTTOM_MARGIN = 8;
const LABEL_GAP = 24;

/** None / Minimal / Full, each with a one-line summary; a tap saves the selected level. */
export class DataCollectionPage implements OnboardingPage {
  /** Width of the level-name column, measured each paint. */
  private labelColumnWidth = 0;
  private readonly menu = new Menu<DataCollectionLevel>({
    items: dataCollectionSetting.values,
    wrap: false,
    rowGap: 2,
    highlight: { radius: 8 },
    getHeight: () => listRowHeight(onboardingFont("body")),
    draw: (args) => this.drawRow(args),
  });

  enter(): void {
    this.menu.select(dataCollectionSetting.values.indexOf(dataCollectionSetting.get()));
  }

  paint(image: GrayImage, focused: boolean): void {
    const top = drawPageHeading(
      image,
      "Faceclaw statistics",
      (global.isIOS ? "If using TestFlight, crash/usage reports cannot be disabled here. " : "") +
        "Choose optional Faceclaw statistics. Change later in Settings > Privacy.",
      3,
    ) + CONTENT_GAP;
    const body = onboardingFont("body");
    this.labelColumnWidth =
      Math.max(...dataCollectionSetting.values.map((level) => body.measureText(dataCollectionSetting.displayValue(level)))) +
      LABEL_GAP;
    this.menu.paint(
      image,
      { x: PAGE_X - 10, y: top, width: image.width - 2 * (PAGE_X - 10), height: image.height - top - BOTTOM_MARGIN },
      focused,
    );
  }

  handleInput(event: InputEvent, nav: OnboardingNav): void {
    switch (event.type) {
      case "scroll-up":
      case "scroll-down":
        void this.menu.handleInput(event);
        return;
      case "click": {
        const level = this.menu.selectedItem;
        if (level !== null) dataCollectionSetting.set(level);
        nav.next();
        return;
      }
      default:
        return;
    }
  }

  private drawRow({ image, item: level, x, y, width, height, selected }: MenuDrawArgs<DataCollectionLevel>): void {
    const body = onboardingFont("body");
    const detail = onboardingFont("detail");
    image.drawText(body, x + 10, y + LIST_ROW_TEXT_INSET, dataCollectionSetting.displayValue(level), selected ? 255 : 200);
    const summaryX = x + 10 + this.labelColumnWidth;
    const summary = truncateText(detail, dataCollectionSummary(level), x + width - 10 - summaryX);
    image.drawText(detail, summaryX, y + Math.round((height - detail.lineHeight) / 2), summary, selected ? 210 : 150);
  }
}
