import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage, type UiFont } from "../../graphics/image";
import { wrapText } from "../../graphics/textwrap";
import { clamp } from "../../util/numeric-util";
import { InputEvent } from "../gestures";
import { Layer, LayerContext, PaintBelow } from "../layers";
import { drawSelectionHighlight, isMenuItemDisabled, MenuItem, MenuLayer, openModalMenu } from "../menu";
import { LIST_ROW_TEXT_INSET, lineStep, listRowHeight } from "../metrics";
import { shell } from "../shell/shell";

/**
 * One left-column entry. `items` are the right-column rows (reusing the shared
 * MenuItem builders). `renderDetail`, when set, draws custom informational
 * content (e.g. About) at the top of the pane and returns the pixel height it
 * consumed; the row list renders below it. Returning nothing claims the whole
 * pane (an info-only section).
 */
export type SettingsSection = {
  label: string;
  items: MenuItem[];
  renderDetail?: (args: {
    image: GrayImage;
    x: number;
    y: number;
    width: number;
    height: number;
    ctx: LayerContext;
  }) => number | void;
};

const PAD = 8;
const LEFT_W = 150;
const MAX_DESCRIPTION_LINES = 3;
// A throwaway menu to satisfy MenuItem.onSelect's second parameter; the
// settings items never use it (they act via ctx only).
const NO_MENU = new MenuLayer(null, []);

/**
 * Two-column (master-detail) settings UI. The left column lists sections; the
 * right column previews the highlighted section's contents. A tap moves focus
 * into the right column, a double-tap moves it back out (and from the left
 * column, out to the sidebar). Third-level menus open as centered modals.
 */
export class SettingsPanelLayer implements Layer {
  // Watch swipes map onto the two columns: right goes into a section's
  // items, left comes back out (and out to the sidebar from the left column).
  readonly acceptsDirectional = true;
  private leftIndex = 0;
  private rightIndex = 0;
  private focus: "left" | "right" = "left";
  private leftScroll = 0;
  private rightScroll = 0;

  constructor(private readonly sections: SettingsSection[]) {}

  private section(): SettingsSection {
    return this.sections[clamp(this.leftIndex, 0, this.sections.length - 1)]!;
  }

  /** Select a left-column section by label (deep link, e.g. from an app's menu). */
  focusSection(label: string): void {
    const index = this.sections.findIndex((section) => section.label === label);
    if (index < 0) return;
    this.leftIndex = index;
    this.focus = "left";
    this.resetRight();
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const appFocused = ctx.stack.isFocused();

    this.leftIndex = clamp(this.leftIndex, 0, this.sections.length - 1);
    const section = this.section();
    const rightItems = section.items;
    this.rightIndex = clamp(this.rightIndex, 0, Math.max(0, rightItems.length - 1));

    const rowH = listRowHeight(font);
    const top = PAD;
    const listBottom = height - PAD;

    // Left column: section labels.
    const leftRows = Math.max(1, ((listBottom - top) / rowH) | 0);
    this.leftScroll = clampScroll(this.leftIndex, this.leftScroll, leftRows, this.sections.length);
    for (let i = this.leftScroll; i < Math.min(this.sections.length, this.leftScroll + leftRows); i++) {
      const rowY = top + (i - this.leftScroll) * rowH;
      const selected = i === this.leftIndex;
      if (selected) {
        drawSelectionHighlight(image, PAD - 2, rowY, LEFT_W, rowH - 2, appFocused && this.focus === "left", 6);
      }
      image.drawText(font, PAD + 8, rowY + LIST_ROW_TEXT_INSET, this.sections[i]!.label, selected ? 255 : 200);
    }

    // Column divider (a light rule, not a full border).
    const divX = PAD + LEFT_W + 6;
    image.drawLine(divX, top, divX, listBottom, 40);

    // Right column: the highlighted section's contents.
    const rightX = divX + 14;
    const rightW = width - rightX - PAD;
    let rightTop = top;
    if (section.renderDetail) {
      const used = section.renderDetail({ image, x: rightX, y: top, width: rightW, height: listBottom - top, ctx });
      rightTop = typeof used === "number" ? Math.min(top + used, listBottom) : listBottom;
    }
    if (rightItems.length && rightTop < listBottom) {
      // Once focus is in the right column, the selected item's extended
      // description (when it has one) is drawn over the bottom of the pane by
      // the companion SettingsDescriptionOverlayLayer. The row list keeps the
      // full column height — rows the description band covers are drawn and
      // partially occluded by the overlay's plane — but the scroll clamp uses
      // the shrunk height so the selected row always stays clear of it.
      const descriptionH = this.descriptionHeight(font, rightW);
      const clampRows = Math.max(1, ((listBottom - descriptionH - rightTop) / rowH) | 0);
      const rightRows = Math.max(1, ((listBottom - rightTop) / rowH) | 0);
      this.rightScroll = clampScroll(this.rightIndex, this.rightScroll, clampRows, rightItems.length);
      for (let i = this.rightScroll; i < Math.min(rightItems.length, this.rightScroll + rightRows); i++) {
        const item = rightItems[i]!;
        const rowY = rightTop + (i - this.rightScroll) * rowH;
        // A selection only appears once focus is in the right column; before
        // that the pane is a preview of what tapping would open.
        const selected = this.focus === "right" && i === this.rightIndex;
        const disabled = isMenuItemDisabled(item);
        if (selected) {
          drawSelectionHighlight(image, rightX - 2, rowY, rightW + 2, rowH - 2, appFocused, 6);
        }
        if (item.render) {
          item.render({
            image,
            x: rightX + 8,
            y: rowY,
            width: rightW - 16,
            height: rowH - 3,
            selected,
            disabled,
            text: item.label,
            ctx,
          });
        } else {
          image.drawText(font, rightX + 8, rowY + LIST_ROW_TEXT_INSET, item.label, disabled ? 70 : selected ? 255 : 200);
        }
      }
    }

    return image;
  }

  /** The selected item's wrapped help text, or [] when none applies. */
  private descriptionLines(font: UiFont, rightW: number): string[] {
    if (this.focus !== "right") return [];
    const items = this.section().items;
    const item = items[clamp(this.rightIndex, 0, Math.max(0, items.length - 1))];
    if (!item?.description) return [];
    return wrapText(font, item.description, rightW - 4).slice(0, MAX_DESCRIPTION_LINES);
  }

  private descriptionHeight(font: UiFont, rightW: number): number {
    const lines = this.descriptionLines(font, rightW);
    return lines.length ? lines.length * lineStep(font) + 10 : 0;
  }

  /**
   * Draw the selected item's help text band (separator + text on an opaque
   * background) at the bottom of the right column. Called by the companion
   * overlay layer with the overlay's own canvas: as a separate plane its
   * raster covers the row list's glyphs, so it can partially occlude a row —
   * which raster drawn into the panel's own image cannot do.
   */
  paintDescriptionOverlay(image: GrayImage, ctx: LayerContext): void {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const listBottom = height - PAD;
    const rightX = PAD + LEFT_W + 6 + 14;
    const rightW = width - rightX - PAD;
    const lines = this.descriptionLines(font, rightW);
    if (!lines.length) return;
    const top = listBottom - (lines.length * lineStep(font) + 10);
    // 1 is opaque black in the plane model (0 is transparent).
    image.fillRect(rightX - 2, top, rightW + 4, listBottom - top, 1);
    image.drawLine(rightX, top, rightX + rightW, top, 40);
    for (let i = 0; i < lines.length; i++) {
      image.drawText(font, rightX + 4, top + 6 + i * lineStep(font), lines[i]!, 150);
    }
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    if (this.focus === "left") {
      switch (event.type) {
        case "scroll-up":
        case "swipe-up":
          this.leftIndex = (this.leftIndex + this.sections.length - 1) % this.sections.length;
          this.resetRight();
          return;
        case "scroll-down":
        case "swipe-down":
          this.leftIndex = (this.leftIndex + 1) % this.sections.length;
          this.resetRight();
          return;
        case "click":
        case "swipe-right":
          // Only enter sections that have something interactive on the right.
          if (this.section().items.length) {
            this.focus = "right";
            this.resetRight();
          }
          return;
        case "double-click":
        case "swipe-left":
          shell.yieldFocusToSidebar();
          return;
        default:
          return;
      }
    }

    const items = this.section().items;
    switch (event.type) {
      case "scroll-up":
      case "swipe-up":
        if (items.length) this.rightIndex = (this.rightIndex + items.length - 1) % items.length;
        return;
      case "scroll-down":
      case "swipe-down":
        if (items.length) this.rightIndex = (this.rightIndex + 1) % items.length;
        return;
      case "click":
      case "swipe-right":
        if (items.length) {
          const item = items[clamp(this.rightIndex, 0, items.length - 1)]!;
          if (!isMenuItemDisabled(item)) await item.onSelect(ctx, NO_MENU);
        }
        return;
      case "double-click":
      case "swipe-left":
        this.focus = "left";
        return;
      default:
        return;
    }
  }

  private resetRight(): void {
    this.rightIndex = 0;
    this.rightScroll = 0;
  }
}

/**
 * Companion layer for SettingsPanelLayer, sitting permanently above it in the
 * settings app's stack: paints the selected item's help text as its own plane
 * (see paintDescriptionOverlay) and forwards all input to the panel. Pushed
 * layers (modal menus, the text editor) stack above it as before.
 */
export class SettingsDescriptionOverlayLayer implements Layer {
  readonly acceptsDirectional = true;

  constructor(private readonly panel: SettingsPanelLayer) {}

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    const image = paintBelow();
    this.panel.paintDescriptionOverlay(image, ctx);
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    return this.panel.handleInput(event, ctx);
  }
}

/**
 * Open a third-level menu as a centered, bordered modal over the panel. Reuses
 * MenuLayer (which draws the border and self-closes on double-click).
 */
export function openSettingsSubMenu(ctx: LayerContext, title: string, items: MenuItem[]): void {
  openModalMenu(ctx, title, items);
}

function clampScroll(selected: number, scroll: number, visible: number, count: number): number {
  if (selected < scroll) {
    scroll = selected;
  } else if (selected >= scroll + visible) {
    scroll = selected - visible + 1;
  }
  return clamp(scroll, 0, Math.max(0, count - visible));
}
