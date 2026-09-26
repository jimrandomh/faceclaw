import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage, type UiFont } from "../../graphics/image";
import { wrapText } from "../../graphics/textwrap";
import { InputEvent } from "../gestures";
import { Layer, LayerContext, PaintBelow } from "../layers";
import { isMenuItemDisabled, MenuItem, MenuLayer, openModalMenu } from "../menu";
import { Menu } from "../menu-core";
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
/** Gap between a row's selection box and the next row. */
const ROW_GAP = 2;
/** Horizontal inset of row text (and custom row content) from its selection box. */
const ROW_TEXT_X = 10;
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
  private focus: "left" | "right" = "left";
  private readonly leftMenu: Menu<SettingsSection>;
  /** The highlighted section's items; unselected while focus is in the left column (a preview). */
  private readonly rightMenu: Menu<MenuItem>;
  /** The context of the paint in progress, handed to item render callbacks. */
  private paintCtx: LayerContext | null = null;

  constructor(private readonly sections: SettingsSection[]) {
    this.leftMenu = new Menu<SettingsSection>({
      items: sections,
      wrap: true,
      rowGap: ROW_GAP,
      highlight: { radius: 6 },
      getHeight: () => listRowHeight(getDefaultSmallFont()),
      draw: ({ image, item, x, y, selected }) => {
        image.drawText(getDefaultSmallFont(), x + ROW_TEXT_X, y + LIST_ROW_TEXT_INSET, item.label, selected ? 255 : 200);
      },
    });
    this.rightMenu = new Menu<MenuItem>({
      items: this.section().items,
      selectedIndex: null,
      wrap: true,
      rowGap: ROW_GAP,
      highlight: { radius: 6 },
      getHeight: () => listRowHeight(getDefaultSmallFont()),
      draw: ({ image, item, x, y, width, height, selected }) => {
        const disabled = isMenuItemDisabled(item);
        if (item.render) {
          item.render({
            image,
            x: x + ROW_TEXT_X,
            y,
            width: width - ROW_TEXT_X - 8,
            height: height - 1,
            selected,
            disabled,
            text: item.label,
            ctx: this.paintCtx!,
          });
        } else {
          image.drawText(getDefaultSmallFont(), x + ROW_TEXT_X, y + LIST_ROW_TEXT_INSET, item.label,
            disabled ? 70 : selected ? 255 : 200);
        }
      },
    });
  }

  private section(): SettingsSection {
    return this.leftMenu.selectedItem ?? this.sections[0]!;
  }

  /** Select a left-column section by label (deep link, e.g. from an app's menu). */
  focusSection(label: string): void {
    const index = this.sections.findIndex((section) => section.label === label);
    if (index < 0) return;
    this.leftMenu.select(index);
    this.focus = "left";
    this.resetRight();
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const appFocused = ctx.stack.isFocused();
    const section = this.section();
    const rightItems = section.items;
    this.rightMenu.setItems(rightItems);

    const top = PAD;
    const listBottom = height - PAD;

    // Left column: section labels.
    this.leftMenu.paint(image, { x: PAD - 2, y: top, width: LEFT_W, height: listBottom - top },
      appFocused && this.focus === "left");

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
      // the companion SettingsDescriptionOverlayLayer. The list stops above
      // that band, so the selected row always stays clear of it.
      const listHeight = listBottom - this.descriptionHeight(font, rightW) - rightTop;
      if (listHeight > 0) {
        this.paintCtx = ctx;
        try {
          this.rightMenu.paint(image, { x: rightX - 2, y: rightTop, width: rightW + 2, height: listHeight }, appFocused);
        } finally {
          this.paintCtx = null;
        }
      }
    }

    return image;
  }

  /** The selected item's wrapped help text, or [] when none applies. */
  private descriptionLines(font: UiFont, rightW: number): string[] {
    if (this.focus !== "right") return [];
    const item = this.rightMenu.selectedItem;
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
   * overlay layer with the overlay's own canvas, so the band stays above
   * whatever the panel paints (including a section's detail content).
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
    const scroll = scrollEventFor(event);
    if (this.focus === "left") {
      if (scroll) {
        const before = this.leftMenu.selectedIndex;
        await this.leftMenu.handleInput(scroll);
        if (this.leftMenu.selectedIndex !== before) this.resetRight();
        return;
      }
      switch (event.type) {
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

    if (scroll) {
      await this.rightMenu.handleInput(scroll);
      return;
    }
    switch (event.type) {
      case "click":
      case "swipe-right": {
        const item = this.rightMenu.selectedItem;
        if (item && !isMenuItemDisabled(item)) await item.onSelect(ctx, NO_MENU);
        return;
      }
      case "double-click":
      case "swipe-left":
        // Back to a preview: the right column keeps its scroll but shows no selection.
        this.focus = "left";
        this.rightMenu.select(null);
        return;
      default:
        return;
    }
  }

  /** Show the highlighted section's items from the top, selected on the first only when focus is there. */
  private resetRight(): void {
    this.rightMenu.setItems(this.section().items, this.focus === "right" ? 0 : null);
    this.rightMenu.scrollTop = 0;
  }
}

/** Scroll and watch swipe-up/down both move a column's selection. */
function scrollEventFor(event: InputEvent): InputEvent | null {
  if (event.type === "scroll-up" || event.type === "swipe-up") return { ...event, type: "scroll-up" } as InputEvent;
  if (event.type === "scroll-down" || event.type === "swipe-down") return { ...event, type: "scroll-down" } as InputEvent;
  return null;
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
