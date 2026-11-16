import type { GrayImage, UiFont } from "../../graphics/image";
import { appSwitcherPositionSetting, glassesTypeSetting, type AppSwitcherPosition } from "../../ui/dashboard-settings";
import type { InputEvent } from "../../ui/gestures";
import { MENU_HIGHLIGHT_FILL, MENU_HIGHLIGHT_STROKE } from "../../ui/menu-core";
import { screenWidth } from "../../ui/shell/geometry";
import type { Edges } from "../../ui/viewport";
import { AREA_OUTLINE, Diagram, diagramBandHeight, drawLayout, layoutAreaHeight } from "./layout-diagram";
import { onboardingFont } from "./onboarding-fonts";
import { centredX, drawPageHeading, type OnboardingNav, type OnboardingPage } from "./onboarding-page";

const CONTENT_GAP = 10;
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
/**
 * Selected on the first visit, and marked: Bottom on the G2, whose 480 rows
 * leave room for the row; a side strip on the RayNeo iO, whose 220 can't.
 */
export function recommendedLayout(): AppSwitcherPosition {
  return glassesTypeSetting.get() === "rayneo-io" ? "left" : "bottom";
}

/** Whether a layout leaves the side margins the display's stereo depth shifts into (geometry.ts uiDepth). */
export function layoutHasDepth(position: AppSwitcherPosition): boolean {
  return position === "bottom" || position === "popup";
}

/**
 * The app switcher position, as a 2×2 grid of captioned diagrams of each
 * layout, Bottom and Popup on top, the recommended one selected at first;
 * swipes move through them in reading order, a tap saves the selected one.
 * The page is immersive, so the diagrams get 40% of the display's width
 * each. The grid is centred in the window, its cells' selection boxes
 * keeping inside the padding of the window's edges. Choosing a layout
 * reflows open windows (the dashboard controller watches the setting).
 */
export class LayoutPage implements OnboardingPage {
  readonly immersive = true;
  /** Kept across visits, so going back returns to the last choice. */
  private selected = LAYOUT_ORDER.indexOf(recommendedLayout());

  paint(image: GrayImage, focused: boolean, padding: Edges<number>): void {
    const top = drawPageHeading(
      image,
      padding,
      "Layout",
      "Swipe to choose where the app switcher goes, then tap to continue.",
    ) + CONTENT_GAP;
    const title = onboardingFont("body");
    const subtitle = onboardingFont("detail");
    const captionHeight = CAPTION_GAP + title.lineHeight + subtitle.lineHeight;
    const available = image.height - top - padding.bottom;
    const availableWidth = image.width - padding.left - padding.right;
    // The most a diagram can take for two rows and two columns of cells to
    // fit, in whole pixels, so rounding its size can't push the grid past
    // the window's padding.
    const maxDiagramHeight = Math.floor((available - ROW_GAP) / 2 - 2 * CELL_PADDING - captionHeight);
    const maxDiagramWidth = Math.floor((availableWidth - COLUMN_GAP) / 2 - 2 * CELL_PADDING);
    // Short of DIAGRAM_SCALE only where two rows of cells wouldn't fit.
    const scale = Math.max(0, Math.min(DIAGRAM_SCALE, maxDiagramHeight / layoutAreaHeight(), maxDiagramWidth / screenWidth()));
    const diagramWidth = Math.round(screenWidth() * scale);
    const diagramHeight = Math.round(layoutAreaHeight() * scale);
    const cellWidth = diagramWidth + 2 * CELL_PADDING;
    const cellHeight = diagramHeight + 2 * CELL_PADDING + captionHeight;
    const left = centredX(image, padding, 2 * cellWidth + COLUMN_GAP);
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
      const caption = position === recommendedLayout() ? `${name} (Recommended)` : name;
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
 * A layout's diagram: the min-height band, with the popup switcher open.
 * Only a bottom switcher row takes rows under the band; without one, the
 * band sits centred in their place, as the band and row share the screen's
 * slack (none on a screen as short as the RayNeo iO's: the band fills it).
 */
function drawLayoutDiagram(d: Diagram, position: AppSwitcherPosition): void {
  d.outline(0, 0, screenWidth(), layoutAreaHeight(), AREA_OUTLINE, 12);
  const height = diagramBandHeight(position);
  const top = position === "bottom" ? 0 : (layoutAreaHeight() - height) / 2;
  drawLayout(d, position, { top, height, fullWidth: false }, true);
}
