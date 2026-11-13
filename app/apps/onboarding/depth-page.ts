import type { GrayImage } from "../../graphics/image";
import { appSwitcherPositionSetting, uiDepthSetting, type UiDepth } from "../../ui/dashboard-settings";
import type { InputEvent } from "../../ui/gestures";
import { Menu, type MenuDrawArgs } from "../../ui/menu-core";
import { LIST_ROW_TEXT_INSET, listRowHeight } from "../../ui/metrics";
import type { Edges } from "../../ui/viewport";
import { layoutHasDepth } from "./layout-page";
import { onboardingFont } from "./onboarding-fonts";
import { drawPageHeading, PAGE_TEXT_INSET, type OnboardingNav, type OnboardingPage } from "./onboarding-page";

const CONTENT_GAP = 10;
const COLUMN_WIDTH = 220;

/**
 * The whole display's stereo depth, after a layout that has one (Bottom or
 * Popup). Not immersive, so the page sits in the chosen layout, and the
 * depth is saved as the selection moves: the shell shifts everything with
 * it, which is the only way to see the difference.
 */
export class DepthPage implements OnboardingPage {
  private readonly menu = new Menu<UiDepth>({
    items: uiDepthSetting.values,
    wrap: false,
    rowGap: 2,
    highlight: { radius: 8 },
    getHeight: () => listRowHeight(onboardingFont("body")),
    draw: (args) => this.drawRow(args),
  });

  applies(): boolean {
    return layoutHasDepth(appSwitcherPositionSetting.get());
  }

  enter(): void {
    this.menu.select(uiDepthSetting.values.indexOf(uiDepthSetting.get()));
  }

  paint(image: GrayImage, focused: boolean, padding: Edges<number>): void {
    const top = drawPageHeading(
      image,
      padding,
      "Depth",
      "Swipe to move the display nearer or farther away, then tap to continue. Change later in Settings > Customization.",
    ) + CONTENT_GAP;
    // The list scrolls, so it runs to the window's bottom edge, with that
    // edge's padding after its last row.
    this.menu.paint(
      image,
      {
        x: padding.left, y: top, width: Math.min(COLUMN_WIDTH, Math.max(0, image.width - padding.left - padding.right)),
        height: Math.max(0, image.height - top), padBottom: padding.bottom,
      },
      focused,
    );
  }

  handleInput(event: InputEvent, nav: OnboardingNav): void {
    switch (event.type) {
      case "scroll-up":
      case "scroll-down": {
        void this.menu.handleInput(event);
        const depth = this.menu.selectedItem;
        if (depth !== null) uiDepthSetting.set(depth);
        return;
      }
      case "click":
        nav.next();
        return;
      default:
        return;
    }
  }

  private drawRow({ image, item: depth, x, y, selected }: MenuDrawArgs<UiDepth>): void {
    image.drawText(onboardingFont("body"), x + PAGE_TEXT_INSET, y + LIST_ROW_TEXT_INSET, uiDepthSetting.displayValue(depth), selected ? 255 : 190);
  }
}
