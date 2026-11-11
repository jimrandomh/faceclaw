import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage, type UiFont } from "../../graphics/image";
import { wrapText } from "../../graphics/textwrap";
import { InputEvent } from "../gestures";
import { Layer, LayerContext, PaintBelow } from "../layers";
import { isMenuItemDisabled, MenuItem, MenuLayer, openModalMenu } from "../menu";
import { Menu } from "../menu-core";
import { LIST_ROW_TEXT_INSET, lineStep, listRowHeight } from "../metrics";
import { shell } from "../shell/shell";
import type { Viewport } from "../viewport";

/**
 * One left-column entry. `items` are the right-column rows (reusing the shared
 * MenuItem builders); it may be a getter for rows that come and go with other
 * settings, since the panel re-reads it on every paint. `renderDetail`, when set, draws custom informational
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

const LEFT_W = 150;
/** Between the left column's rows and the divider, and between the divider and the right column's content. */
const DIVIDER_GAP_LEFT = 8;
const DIVIDER_GAP_RIGHT = 14;
/** How far a right-column row's selection box overhangs the column's content on the left. */
const RIGHT_ROW_OVERHANG = 2;
/** Gap between a row's selection box and the next row. */
const ROW_GAP = 2;
/** Horizontal inset of row text (and custom row content) from its selection box. */
const ROW_TEXT_X = 10;
const MAX_DESCRIPTION_LINES = 3;
/** Rows a section's list keeps beside its detail while focus is in it (see detailCrowdsList). */
const MIN_LIST_ROWS = 3;
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
    const viewport = ctx.stack.getBaseSize();
    const { width, height, padding } = viewport;
    const image = new GrayImage(width, height, 0);
    const appFocused = ctx.stack.isFocused();
    const section = this.section();
    const rightItems = section.items;
    this.rightMenu.setItems(rightItems);

    // Fixed content keeps the padding suggested for the window's edges. The
    // two lists scroll, so they run to the top and bottom edges themselves,
    // with that padding inside them (before the first row, after the last).
    const { top, bottom: listBottom, divX, rightX, rightW } = panelColumns(viewport);

    // Left column: section labels.
    this.leftMenu.paint(image, { x: padding.left, y: 0, width: LEFT_W, height, padTop: padding.top, padBottom: padding.bottom },
      appFocused && this.focus === "left");

    // Column divider (a light rule, not a full border).
    image.drawLine(divX, top, divX, listBottom, 40);

    // Right column: the highlighted section's contents.
    let rightTop = top;
    if (section.renderDetail && !this.detailCrowdsList(section, ctx, font, { x: rightX, y: top, width: rightW, height: listBottom - top })) {
      const used = section.renderDetail({ image, x: rightX, y: top, width: rightW, height: listBottom - top, ctx });
      rightTop = typeof used === "number" ? Math.min(top + used, listBottom) : listBottom;
    }
    if (rightItems.length && rightTop < listBottom) {
      // Once focus is in the right column, the selected item's extended
      // description (when it has one) is drawn over the bottom of the pane by
      // the companion SettingsDescriptionOverlayLayer. The list stops above
      // that band, so the selected row always stays clear of it. Under a
      // detail, and above that band, the list ends short of the window's
      // edge, where it needs no padding of its own.
      const description = this.descriptionHeight(font, rightW);
      const fromEdge = rightTop === top;
      const listTop = fromEdge ? 0 : rightTop;
      const listEnd = description ? listBottom - description : height;
      if (listEnd > rightTop) {
        this.paintCtx = ctx;
        try {
          this.rightMenu.paint(image, {
            x: rightX - RIGHT_ROW_OVERHANG, y: listTop, width: rightW + RIGHT_ROW_OVERHANG, height: listEnd - listTop,
            padTop: fromEdge ? padding.top : 0, padBottom: description ? 0 : padding.bottom,
          }, appFocused);
        } finally {
          this.paintCtx = null;
        }
      }
    }

    return image;
  }

  /**
   * Whether the section's detail (About's blurb, the watch status) would
   * leave its rows less than MIN_LIST_ROWS while focus is in them, as on a
   * short screen (the RayNeo iO's): the list then takes the whole pane, the
   * detail staying in the preview. Measured by drawing the detail on a
   * scratch image.
   */
  private detailCrowdsList(
    section: SettingsSection,
    ctx: LayerContext,
    font: UiFont,
    pane: { x: number; y: number; width: number; height: number },
  ): boolean {
    if (this.focus !== "right" || !section.items.length || !section.renderDetail) return false;
    const scratch = new GrayImage(pane.x + pane.width, pane.y + pane.height, 0);
    const used = section.renderDetail({ image: scratch, ...pane, ctx });
    if (typeof used !== "number") return false;
    const rows = Math.min(MIN_LIST_ROWS, section.items.length);
    const room = pane.height - used - this.descriptionHeight(font, pane.width);
    return room < rows * (listRowHeight(font) + ROW_GAP);
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
    const { bottom: listBottom, rightX, rightW } = panelColumns(ctx.stack.getBaseSize());
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

/**
 * The panel's fixed geometry in a viewport: the rows fixed content spans
 * (inside the padding suggested for the top and bottom edges), the divider's
 * x, and the right column's content span. The left column's rows start at
 * the left edge's padding; the right column ends at the right edge's.
 */
function panelColumns(viewport: Viewport): { top: number; bottom: number; divX: number; rightX: number; rightW: number } {
  const { width, height, padding } = viewport;
  const divX = padding.left + LEFT_W + DIVIDER_GAP_LEFT;
  const rightX = divX + DIVIDER_GAP_RIGHT;
  return { top: padding.top, bottom: height - padding.bottom, divX, rightX, rightW: width - rightX - padding.right };
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
