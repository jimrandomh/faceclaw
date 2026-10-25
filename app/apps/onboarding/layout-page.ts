import { G2_LENS_WIDTH, type GrayImage, type UiFont } from "../../graphics/image";
import { appSwitcherPositionSetting, type AppSwitcherPosition } from "../../ui/dashboard-settings";
import type { InputEvent } from "../../ui/gestures";
import { MENU_HIGHLIGHT_FILL, MENU_HIGHLIGHT_STROKE } from "../../ui/menu-core";
import { MIN_WINDOW_HEIGHT } from "../../ui/shell/geometry";
import { AREA_OUTLINE, Diagram, drawLayout, LAYOUT_AREA_HEIGHT } from "./layout-diagram";
import { onboardingFont } from "./onboarding-fonts";
import { drawPageHeading, type OnboardingNav, type OnboardingPage } from "./onboarding-page";

const CONTENT_GAP = 10;
const BOTTOM_MARGIN = 8;
/** Diagram width as a fraction of the display's: the most a diagram is drawn at. */
const DIAGRAM_SCALE = 0.4;
/** Padding inside a cell's selection box, round the diagram and its caption. */
const CELL_PADDING = 8;
const CAPTION_GAP = 4;
const COLUMN_GAP = 16;
const ROW_GAP = 6;
const DEPTH_SUBTITLE = "Customizable Depth";
/** Grid order, in rows of two: the layouts with depth on top. */
const LAYOUT_ORDER: readonly AppSwitcherPosition[] = ["bottom", "popup", "left", "right"];
/** Selected on the first visit, and marked. */
const RECOMMENDED_LAYOUT: AppSwitcherPosition = "bottom";

/** Whether a layout leaves the side margins the display's stereo depth shifts into (geometry.ts uiDepth). */
export function layoutHasDepth(position: AppSwitcherPosition): boolean {
  return position === "bottom" || position === "popup";
}

/**
 * The app switcher position, as a 2×2 grid of captioned diagrams of each
 * layout, Bottom (recommended, and selected at first) and Popup on top;
 * swipes move through them in reading order, a tap saves the selected one.
 * The page is immersive, so the diagrams get 40% of the display's width
 * each. Choosing a layout reflows open windows (the dashboard controller
 * watches the setting).
 */
export class LayoutPage implements OnboardingPage {
  readonly immersive = true;
  /** Kept across visits, so going back returns to the last choice. */
  private selected = LAYOUT_ORDER.indexOf(RECOMMENDED_LAYOUT);

  paint(image: GrayImage, focused: boolean): void {
    const top = drawPageHeading(
      image,
      "Layout",
      "Swipe to choose where the app switcher goes, then tap to continue.",
    ) + CONTENT_GAP;
    const title = onboardingFont("body");
    const subtitle = onboardingFont("detail");
    const captionHeight = CAPTION_GAP + title.lineHeight + subtitle.lineHeight;
    const available = image.height - top - BOTTOM_MARGIN;
    // Short of DIAGRAM_SCALE only where two rows of cells wouldn't fit.
    const scale = Math.min(
      DIAGRAM_SCALE,
      ((available - ROW_GAP) / 2 - 2 * CELL_PADDING - captionHeight) / LAYOUT_AREA_HEIGHT,
      ((image.width - COLUMN_GAP) / 2 - 2 * CELL_PADDING) / G2_LENS_WIDTH,
    );
    const diagramWidth = Math.round(G2_LENS_WIDTH * scale);
    const diagramHeight = Math.round(LAYOUT_AREA_HEIGHT * scale);
    const cellWidth = diagramWidth + 2 * CELL_PADDING;
    const cellHeight = diagramHeight + 2 * CELL_PADDING + captionHeight;
    const left = Math.round((image.width - 2 * cellWidth - COLUMN_GAP) / 2);
    const gridTop = top + Math.max(0, Math.round((available - 2 * cellHeight - ROW_GAP) / 2));
    LAYOUT_ORDER.forEach((position, index) => {
      const x = left + (index % 2) * (cellWidth + COLUMN_GAP);
      const y = gridTop + Math.floor(index / 2) * (cellHeight + ROW_GAP);
      const selected = index === this.selected;
      if (selected) {
        if (focused) image.fillRoundedRect(x, y, cellWidth, cellHeight, MENU_HIGHLIGHT_FILL, 8);
        image.drawRoundedRect(x, y, cellWidth, cellHeight, MENU_HIGHLIGHT_STROKE, 8);
      }
      drawLayoutDiagram(new Diagram(image, x + CELL_PADDING, y + CELL_PADDING, scale), position);
      const centre = (text: string, font: UiFont, textY: number, value: number) =>
        image.drawText(font, x + Math.round((cellWidth - font.measureText(text)) / 2), textY, text, value);
      const captionTop = y + CELL_PADDING + diagramHeight + CAPTION_GAP;
      const name = appSwitcherPositionSetting.displayValue(position);
      const caption = position === RECOMMENDED_LAYOUT ? `${name} (Recommended)` : name;
      centre(caption, title, captionTop, selected ? 255 : 190);
      if (layoutHasDepth(position)) {
        centre(DEPTH_SUBTITLE, subtitle, captionTop + title.lineHeight, selected ? 210 : 150);
      }
    });
  }

  handleInput(event: InputEvent, nav: OnboardingNav): void {
    const last = LAYOUT_ORDER.length - 1;
    switch (event.type) {
      case "scroll-up":
        this.selected = Math.max(0, this.selected - 1);
        return;
      case "scroll-down":
        this.selected = Math.min(last, this.selected + 1);
        return;
      case "click":
        appSwitcherPositionSetting.set(LAYOUT_ORDER[this.selected]!);
        nav.next();
        return;
      default:
        return;
    }
  }
}

/**
 * A layout's diagram: the 288px band, with the popup switcher open. Only a
 * bottom switcher row takes rows under the band; without one, the band sits
 * centred in their place, as the band and row share the screen's slack.
 */
function drawLayoutDiagram(d: Diagram, position: AppSwitcherPosition): void {
  d.outline(0, 0, G2_LENS_WIDTH, LAYOUT_AREA_HEIGHT, AREA_OUTLINE, 12);
  const top = position === "bottom" ? 0 : (LAYOUT_AREA_HEIGHT - MIN_WINDOW_HEIGHT) / 2;
  drawLayout(d, position, { top, height: MIN_WINDOW_HEIGHT, fullWidth: false }, true);
}
