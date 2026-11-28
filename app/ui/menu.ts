import { GrayImage, imageFromAsciiArt, TOGGLE_SWITCH_HEIGHT, TOGGLE_SWITCH_WIDTH, type ToggleSwitchAnimation, type UiFont } from "../graphics/image";
import { screenHeight } from "../graphics/screen-size";
import { wrapText } from "../graphics/textwrap";
import { getDefaultSmallFont } from "../graphics/ui-fonts";
import { getStringSetting } from "../native/settings-store";
import { clamp } from "../util/numeric-util";
import { normalizeAnimationSpeed } from "./animation-speed";
import { Layer, LayerContext, PaintBelow } from "./layers";
import { MENU_ANIMATION_KEY, menuAnimationDurationMs, nextAnimationToken, setMenuAnimationReader } from "./menu-animation-pref";
import { Menu, MENU_HIGHLIGHT_FILL, MENU_HIGHLIGHT_STROKE } from "./menu-core";

import { GESTURE_DOUBLE_CLICK, InputEvent } from "./gestures";
import { LIST_ROW_TEXT_INSET, lineStep, listRowHeight, menuTitleHeight } from "./metrics";

// Menu<T> and IconGrid consult this (through their motion classes) at each
// paint; a SharedPreferences read, so changes apply to the next navigation.
setMenuAnimationReader(() => normalizeAnimationSpeed(getStringSetting(MENU_ANIMATION_KEY, "normal")));

const DEFAULT_MENU_X = 8;
const DEFAULT_MENU_Y = 8;
const DEFAULT_MENU_WIDTH = 272;
/** Windows shorter than this (the RayNeo iO's, not the G2's) get tighter modal margins. */
const SHORT_WINDOW_HEIGHT = 200;
// Menus grow with their item count, from half the screen (matching the old
// fixed quarter-screen-era look) up to the full screen, then scroll.
/** Half the screen, less the menu's top and bottom offsets. */
function defaultMenuMinHeight(): number {
  return screenHeight() / 2 - 2 * DEFAULT_MENU_Y;
}
const MENU_BODY_PADDING = 8;
/** Gap between the last item row and a footer hint line. */
const MENU_FOOTER_GAP = 8;
/** Horizontal inset of the row (highlight) boxes from the menu box's edges. */
const MENU_ROW_INSET = 12;
/** Horizontal inset of row text from the row box. */
const MENU_ROW_TEXT_INSET = 10;
/** A page menu's title: how far below the window's top padding, and the gap under its band. */
const PAGE_TITLE_OFFSET_Y = 2;
const PAGE_TITLE_GAP = 4;
/** Room a page menu keeps right of its rows for the scrollbar. */
const PAGE_SCROLLBAR_GUTTER = 6;
/** A heading row's text: dimmer than a row's, brighter than a disabled row's. */
const MENU_HEADING_VALUE = 90;

export type MenuLayout = {
  /** Stereo depth of the menu surface, including the selected row. */
  depth?: number;
  /** Left edge, or "center" to center horizontally on the painted surface. */
  x: number | "center";
  y: number;
  width: number;
  /** Whether to draw the rounded outline around the menu. Default: true. */
  showBorder?: boolean;
  /** Smallest box to draw even when items don't fill it. Default: top half of the screen. */
  minHeight?: number;
  /** Height cap before the menu starts scrolling. Default: the full screen. */
  maxHeight?: number;
  /**
   * Dim hint line pinned to the bottom edge inside the box, below the items
   * (gesture help such as "●— system menu"). Takes a line off the item area.
   */
  footer?: MenuFooter;
  /** Brightness factor for everything beneath the menu (see Layer.dimUnderneath). Default: none. */
  dimUnderneath?: number;
  /**
   * Paint as a standalone page: the layers below stay in the stack for back
   * navigation but are not composited underneath. Default: false — the menu
   * renders over whatever is below it (modal/window menus).
   */
  opaque?: boolean;
  squareCorners?: boolean;
};

/**
 * A menu laid out as a page of its window rather than a box floating over
 * it (an app's root menu, a settings sub-screen): opaque, with no outline.
 * Its rows start at the padding suggested for the window's left edge
 * (viewport.ts) and its title lines up with their text. The title and a
 * footer stay put, inside the top and bottom padding; the rows scroll
 * between them, or right to the window's top or bottom edge where there is
 * none, with that edge's padding inside the list.
 */
export type MenuPageLayout = {
  page: true;
  /** Width of the rows. Default (and at most): the window's, inside its side padding. */
  width?: number;
  /** Dim hint line pinned above the window's bottom padding, below the rows. */
  footer?: MenuFooter;
};

/** A menu's footer line: fixed text, or read on every paint (a live value). */
export type MenuFooter = string | (() => string);

function footerText(footer: MenuFooter): string {
  return typeof footer === "function" ? footer() : footer;
}

export type MenuItemRenderArgs = {
  image: GrayImage;
  x: number;
  y: number;
  width: number;
  height: number;
  selected: boolean;
  disabled: boolean;
  text: string;
  ctx: LayerContext;
};

export type MenuItem = {
  label: string;
  /** Extended description; the Settings panel shows it below the list while the item is selected. */
  description?: string;
  /** Disabled rows stay visible but render dimly and ignore clicks. */
  disabled?: boolean | (() => boolean);
  /**
   * A label for the group of rows after it (see menuHeadingItem). MenuLayer's
   * highlight skips it; a list that doesn't know headings shows it as a
   * disabled row.
   */
  heading?: boolean;
  onSelect: (ctx: LayerContext, menu: MenuLayer) => Promise<void> | void;
  render?: (args: MenuItemRenderArgs) => void;
};

/**
 * Draw a selection highlight for a list row. A focused list fills the row and
 * outlines it; a visible-but-unfocused list draws only the outline, so the
 * selection stays legible without implying it will receive input.
 */
export function drawSelectionHighlight(
  image: GrayImage,
  x: number,
  y: number,
  width: number,
  height: number,
  focused: boolean,
  radius = 6,
): void {
  if (focused) {
    image.fillRoundedRect(x, y, width, height, MENU_HIGHLIGHT_FILL, radius);
  }
  image.drawRoundedRect(x, y, width, height, MENU_HIGHLIGHT_STROKE, radius);
}

/**
 * Move a list's scroll position the minimum distance needed to keep the
 * selected row inside the visible window, clamped to the list bounds.
 * Returns the new scroll row (the index of the first visible item).
 */
export function scrollToKeepSelectionVisible(
  scrollRow: number,
  selectedIndex: number,
  visibleRowCount: number,
  itemCount: number,
): number {
  if (selectedIndex < scrollRow) {
    scrollRow = selectedIndex;
  } else if (selectedIndex >= scrollRow + visibleRowCount) {
    scrollRow = selectedIndex - visibleRowCount + 1;
  }
  return clamp(scrollRow, 0, Math.max(0, itemCount - visibleRowCount));
}

/**
 * Draw a vertical scrollbar beside a row-scrolled list: a dim track with a
 * proportional thumb positioned by scroll fraction. Only call when the list
 * actually overflows (itemCount > visibleRowCount).
 */
export function drawListScrollbar(
  image: GrayImage,
  trackX: number,
  trackY: number,
  trackHeight: number,
  scrollRow: number,
  visibleRowCount: number,
  itemCount: number,
): void {
  image.fillRect(trackX, trackY, 3, trackHeight, 30);
  const thumbHeight = Math.max(8, (trackHeight * visibleRowCount / itemCount) | 0);
  const maxScrollRow = Math.max(1, itemCount - visibleRowCount);
  const thumbY = trackY + (((trackHeight - thumbHeight) * clamp(scrollRow, 0, maxScrollRow) / maxScrollRow) | 0);
  image.fillRect(trackX, thumbY, 3, thumbHeight, 120);
}

/**
 * The submenu indicator: a solid right-pointing triangle, as a bitmap rather
 * than a "▶" character. As text it came from a fallback face wherever the UI
 * font lacks the glyph, and Android's and iOS's fallbacks draw different
 * triangles. Antialiased by hand: the edges rise one row per two columns, so
 * each row ends in a 3/4 pixel and then a 1/4 pixel.
 */
const SUBMENU_ARROW_PALETTE = { "#": 255, "+": 191, "-": 64 };
const SUBMENU_ARROW = imageFromAsciiArt(
  [
    "+-........",
    "##+-......",
    "####+-....",
    "######+-..",
    "########+-",
    "########+-",
    "######+-..",
    "####+-....",
    "##+-......",
    "+-........",
  ],
  SUBMENU_ARROW_PALETTE,
);
/** For small fonts; the glyph it replaces scaled with the text. */
const SMALL_SUBMENU_ARROW = imageFromAsciiArt(
  [
    "+-....",
    "##+-..",
    "####+-",
    "####+-",
    "##+-..",
    "+-....",
  ],
  SUBMENU_ARROW_PALETTE,
);
/** Fonts with a shorter line than this get SMALL_SUBMENU_ARROW (the 12px bitmap faces do). */
const SUBMENU_ARROW_MIN_LINE_HEIGHT = 15;
/** Gap between the triangle's tip and the right edge of the row's rect. */
const SUBMENU_ARROW_INSET = 4;

/**
 * The triangles at each brightness they have been drawn at. drawImage sources
 * must be long-lived (the glasses cache them by content), and rows only use a
 * handful of text values.
 */
const tintedSubmenuArrows = new Map<GrayImage, Map<number, GrayImage>>();

function submenuArrow(font: UiFont, value: number): GrayImage {
  const base = font.lineHeight < SUBMENU_ARROW_MIN_LINE_HEIGHT ? SMALL_SUBMENU_ARROW : SUBMENU_ARROW;
  const level = clamp(Math.round(value), 0, 255);
  let tints = tintedSubmenuArrows.get(base);
  if (!tints) tintedSubmenuArrows.set(base, tints = new Map());
  let arrow = tints.get(level);
  if (!arrow) tints.set(level, arrow = base.dimmed(level / 255));
  return arrow;
}

/**
 * Draw the submenu indicator (a "▶" triangle, sized for `font`) inset at the
 * right edge of a row's selection highlight box, vertically centered within
 * it. Pass the same rect as the row's drawSelectionHighlight call (the row
 * need not actually be selected). `value` is the brightness of the row's text.
 */
export function drawSubmenuIndicator(
  image: GrayImage,
  font: UiFont,
  highlightX: number,
  highlightY: number,
  highlightWidth: number,
  highlightHeight: number,
  value: number,
): void {
  const arrow = submenuArrow(font, value);
  const x = Math.round(highlightX + highlightWidth) - arrow.width - SUBMENU_ARROW_INSET;
  // A spare pixel goes above the triangle, which is where the glyph sat.
  const y = Math.round(highlightY + (highlightHeight - arrow.height) / 2);
  image.drawImage(arrow, x, y);
}

/** A row that opens a nested menu: the label plus a right-edge triangle. */
export function submenuItem(
  label: string,
  onSelect: MenuItem["onSelect"],
  options: Pick<MenuItem, "description" | "disabled"> = {},
): MenuItem {
  return {
    ...options,
    label,
    onSelect,
    render: ({ image, x, y, width, height, selected, disabled, text }) => {
      const font = getDefaultSmallFont();
      const value = disabled ? 70 : selected ? 255 : 200;
      image.drawText(font, x, y + LIST_ROW_TEXT_INSET, text, value);
      drawSubmenuIndicator(image, font, x, y, width, height, value);
    },
  };
}

/**
 * A heading for the rows that follow it, splitting a long menu into sections:
 * dim capitals in the rows' text column, never selected.
 */
export function menuHeadingItem(label: string): MenuItem {
  return {
    label,
    heading: true,
    disabled: true,
    onSelect: () => {},
    render: ({ image, x, y, text }) => {
      image.drawText(getDefaultSmallFont(), x, y + LIST_ROW_TEXT_INSET, text.toUpperCase(), MENU_HEADING_VALUE);
    },
  };
}

/** A switch's flip, at Normal menu animation speed. */
const TOGGLE_ANIMATION_MS = 140;
/** How many toggles' states are remembered for animating; the oldest are forgotten first. */
const MAX_TOGGLE_STATES = 128;

/** What each keyed toggle last showed, and its flip while one is under way. */
const toggleStates = new Map<string, { on: boolean; animation?: ToggleSwitchAnimation }>();

/**
 * The flip to play for the toggle `key` painted as `on` now: one starts when a
 * paint finds the toggle changed since its last paint, and later paints carry
 * it until it is done. A toggle's first paint just shows its state.
 */
function toggleAnimation(key: string, on: boolean): ToggleSwitchAnimation | undefined {
  const now = Date.now();
  let state = toggleStates.get(key);
  if (!state) {
    if (toggleStates.size >= MAX_TOGGLE_STATES) toggleStates.delete(toggleStates.keys().next().value!);
    toggleStates.set(key, state = { on });
  } else if (state.on !== on) {
    const durationMs = menuAnimationDurationMs(TOGGLE_ANIMATION_MS);
    state.on = on;
    state.animation = durationMs > 0 ? { startedAt: now, token: nextAnimationToken(), durationMs } : undefined;
  }
  const animation = state.animation;
  return animation && now - animation.startedAt < animation.durationMs ? animation : undefined;
}

/**
 * A row with a label and a switch at its right edge. `motionKey` names the
 * toggle across paints (a setting's storage key, say), which lets the switch
 * animate when it flips; without one it just shows its state.
 */
export function drawToggleMenuItem(
  image: GrayImage,
  font: UiFont,
  x: number,
  y: number,
  width: number,
  label: string,
  enabled: boolean,
  selected: boolean,
  motionKey?: string,
): void {
  const switchX = x + width - TOGGLE_SWITCH_WIDTH - 2;
  // Center the switch on the row's line box (legacy y+1 at the 12px default).
  const switchY = y + Math.max(1, Math.round((listRowHeight(font) - 2 - TOGGLE_SWITCH_HEIGHT) / 2));
  image.drawText(font, x, y + LIST_ROW_TEXT_INSET, label, 200);
  image.drawToggleSwitch(switchX, switchY, enabled, selected,
    motionKey === undefined ? undefined : toggleAnimation(motionKey, enabled));
}

export function drawRightValueMenuItem(
  image: GrayImage,
  font: UiFont,
  x: number,
  y: number,
  width: number,
  label: string,
  value: string,
): void {
  image.drawText(font, x, y + LIST_ROW_TEXT_INSET, label, 200);
  const valueX = x + width - font.measureText(value) - 2;
  image.drawText(font, valueX, y + LIST_ROW_TEXT_INSET, value, 220);
}

/** How far context menus (window and system) dim the content beneath them. */
export const CONTEXT_MENU_DIM = 0.25;

export class MenuLayer implements Layer {
  private readonly menu: Menu<MenuItem>;
  /** The context of the paint in progress, handed to item render callbacks. */
  private paintCtx: LayerContext | null = null;

  get depth(): number { return "page" in this.layout ? 0 : this.layout.depth ?? 0; }

  get dimUnderneath(): false | number {
    return "page" in this.layout ? false : this.layout.dimUnderneath ?? false;
  }

  constructor(
    private readonly title: string | null,
    private items: MenuItem[],
    private readonly layout: MenuLayout | MenuPageLayout = {
      x: DEFAULT_MENU_X,
      y: DEFAULT_MENU_Y,
      width: DEFAULT_MENU_WIDTH,
    },
    public readonly paintOverBase = false,
  ) {
    this.menu = new Menu<MenuItem>({
      items,
      wrap: true,
      rowGap: 1,
      getHeight: () => listRowHeight(getDefaultSmallFont()),
      isSelectable: (item) => !item.heading,
      draw: ({ image, item, x, y, width, height, selected }) => {
        const font = getDefaultSmallFont();
        const disabled = isMenuItemDisabled(item);
        if (item.render) {
          item.render({
            image,
            x: x + MENU_ROW_TEXT_INSET,
            y,
            width: width - 2 * MENU_ROW_TEXT_INSET,
            height: height - 2,
            selected,
            disabled,
            text: item.label,
            ctx: this.paintCtx!,
          });
        } else {
          image.drawText(font, x + MENU_ROW_TEXT_INSET, y + LIST_ROW_TEXT_INSET, item.label,
            disabled ? 70 : selected ? 255 : 200);
        }
      },
    });
  }

  /** Start a newly opened picker on its current value. */
  selectItem(index: number): this {
    this.menu.select(index);
    return this;
  }

  /** The selected row's index, or null when nothing is selectable. */
  get selectedIndex(): number | null {
    return this.menu.selectedIndex;
  }

  get selectedItem(): MenuItem | null {
    return this.menu.selectedItem;
  }

  /**
   * Replace the rows in place, keeping scroll and highlight state. The
   * selection follows Menu.setItems: pass the new index of the previously
   * selected row, or leave it out to keep the same index, clamped.
   */
  setItems(items: MenuItem[], selectedIndex?: number | null): void {
    this.items = items;
    this.menu.setItems(items, selectedIndex);
  }

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    if ("page" in this.layout) return this.paintPage(ctx, this.layout);
    const layout = this.layout;
    const font = getDefaultSmallFont();
    const rowHeight = listRowHeight(font);
    const base = ctx.stack.getBaseSize();
    const image = layout.opaque ? new GrayImage(base.width, base.height, 0) : paintBelow();
    const { y, width } = layout;
    const x = layout.x === "center" ? ((image.width - width) / 2) | 0 : layout.x;
    const chromeTop = (this.title ? menuTitleHeight(font) : 0) + MENU_BODY_PADDING;
    const minHeight = layout.minHeight ?? defaultMenuMinHeight();
    // Cap to the surface being painted on: a window's stack image may be much
    // shorter than the full screen (min-height windows).
    const maxHeight = Math.min(
      layout.maxHeight ?? image.height - y - DEFAULT_MENU_Y,
      image.height - y,
      (layout.squareCorners || this.depth !== 0) ? Math.floor(65530 / Math.ceil(width / 2)) : Infinity,
    );
    const footerHeight = layout.footer ? MENU_FOOTER_GAP + lineStep(font) : 0;
    const contentHeight = chromeTop + this.items.length * rowHeight + footerHeight + MENU_BODY_PADDING;
    const height = clamp(contentHeight, Math.min(minHeight, maxHeight), maxHeight);
    const visibleRowCount = Math.max(
      1,
      ((height - chromeTop - footerHeight - MENU_BODY_PADDING) / rowHeight) | 0,
    );

    // Fill 1, not 0: identical after 4bpp quantization, but 0 is the
    // transparent color key when a menu paints on the shell surface.
    if (layout.squareCorners) image.fillRect(x, y, width, height, 1);
    else image.fillRoundedRect(x, y, width, height, 1);
    if (layout.showBorder !== false) {
      if (layout.squareCorners) image.drawRect(x, y, width, height, 72);
      else image.drawRoundedRect(x, y, width, height, 72);
    }
    if (this.title) {
      image.drawText(font, x + 12, y + 8, this.title, 220);
    }
    if (layout.footer) {
      image.drawText(font, x + 22, y + height - MENU_BODY_PADDING - font.lineHeight, footerText(layout.footer), 110);
    }

    const bodyY = y + chromeTop;
    const listHeight = visibleRowCount * rowHeight;
    this.paintCtx = ctx;
    try {
      this.menu.paint(image, { x: x + MENU_ROW_INSET, y: bodyY, width: width - 2 * MENU_ROW_INSET, height: listHeight },
        ctx.stack.isFocused());
    } finally {
      this.paintCtx = null;
    }
    this.menu.drawScrollbar(image, x + width - 7, bodyY, listHeight - 4);
    return image;
  }

  /** Paint as a page of the window (see MenuPageLayout). */
  private paintPage(ctx: LayerContext, layout: MenuPageLayout): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height, padding } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const x = padding.left;
    const available = Math.max(0, width - padding.left - padding.right - PAGE_SCROLLBAR_GUTTER);
    const rowsWidth = Math.min(layout.width ?? available, available);
    // Fixed parts keep inside the window's padding; the list's box runs to
    // an edge nothing fixed stands before, taking that edge's padding as its own.
    let top = 0;
    let fixedTop = padding.top;
    if (this.title) {
      const titleY = padding.top + PAGE_TITLE_OFFSET_Y;
      image.drawText(font, x + MENU_ROW_TEXT_INSET, titleY, this.title, 220);
      top = fixedTop = titleY + menuTitleHeight(font) + PAGE_TITLE_GAP;
    }
    let bottom = height;
    let fixedBottom = height - padding.bottom;
    if (layout.footer) {
      const footerY = height - padding.bottom - font.lineHeight;
      image.drawText(font, x + MENU_ROW_TEXT_INSET, footerY, footerText(layout.footer), 110);
      bottom = fixedBottom = footerY - MENU_FOOTER_GAP;
    }
    if (bottom <= top || rowsWidth <= 0) {
      this.menu.clearHitTest();
      return image;
    }
    this.paintCtx = ctx;
    try {
      this.menu.paint(image, { x, y: top, width: rowsWidth, height: bottom - top, padTop: fixedTop - top, padBottom: bottom - fixedBottom },
        ctx.stack.isFocused());
    } finally {
      this.paintCtx = null;
    }
    this.menu.drawScrollbar(image, x + rowsWidth + PAGE_SCROLLBAR_GUTTER - 3, fixedTop, Math.max(0, fixedBottom - fixedTop));
    return image;
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    switch (event.type) {
      case "double-click":
        ctx.stack.pop();
        return;
      case "click":
        await this.activateRow(this.menu.selectedIndex, ctx);
        return;
      default:
        await this.menu.handleInput(event);
        return;
    }
  }

  async hitTest(x: number, y: number, ctx: LayerContext): Promise<boolean> {
    await this.activateRow(this.menu.indexAt(y, x), ctx);
    // A tap on the heading, spacer or background still belongs to this menu.
    return true;
  }

  private async activateRow(index: number | null, ctx: LayerContext): Promise<void> {
    if (index === null) return;
    const item = this.items[index];
    if (!item || isMenuItemDisabled(item)) return;
    if (this.menu.selectedIndex !== index) this.menu.select(index);
    await item.onSelect(ctx, this);
  }
}

export type ModalMenuOptions = {
  /** A dim line under the items (see MenuLayout.footer). */
  footer?: MenuFooter;
  /** Runs when the menu leaves the stack, however it closes. */
  onClosed?: () => void;
};

/** Open a centered, bordered menu over the current layer. */
export function openModalMenu(
  ctx: LayerContext,
  title: string,
  items: MenuItem[],
  initialSelectedIndex = 0,
  options: ModalMenuOptions = {},
): void {
  const { width, height } = ctx.stack.getBaseSize();
  const font = getDefaultSmallFont();
  const menuWidth = Math.min(320, width - 40);
  const footerHeight = options.footer ? MENU_FOOTER_GAP + lineStep(font) : 0;
  const naturalHeight = menuTitleHeight(font) + 2 * MENU_BODY_PADDING + items.length * listRowHeight(font) + footerHeight;
  // 20px clear above and below, or 8 in a short window (the RayNeo iO's),
  // where those rows are worth more than the margin.
  const marginY = height < SHORT_WINDOW_HEIGHT ? 8 : 20;
  const menuHeight = Math.min(naturalHeight, height - 2 * marginY);
  const layout: MenuLayout = {
    x: ((width - menuWidth) / 2) | 0,
    y: ((height - menuHeight) / 2) | 0,
    width: menuWidth,
    minHeight: menuHeight,
    maxHeight: menuHeight,
    // Floats nearer than the content it opens over, like the window and system menus.
    depth: 4,
    footer: options.footer,
  };
  ctx.stack.push(new ModalMenuLayer(title, items, layout, options.onClosed).selectItem(initialSelectedIndex));
}

class ModalMenuLayer extends MenuLayer {
  constructor(title: string, items: MenuItem[], layout: MenuLayout, private readonly onClosed?: () => void) {
    super(title, items, layout);
  }

  onRemoved(): void {
    this.onClosed?.();
  }
}

export function isMenuItemDisabled(item: MenuItem): boolean {
  return typeof item.disabled === "function" ? item.disabled() : item.disabled === true;
}

export class TextPageLayer implements Layer {
  constructor(
    private readonly title: string,
    private readonly body: string,
  ) {}

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    // Size to the stack, not the lens: in an app window the stack is the
    // window's viewport, and the compositor rejects a frame larger than its
    // surface (leaving the previous frame on screen).
    const { width, height, padding } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    // The page's own outline sits at the padding suggested for each window
    // edge; everything else is placed from it.
    const box = { x: padding.left, y: padding.top, width: width - padding.left - padding.right, height: height - padding.top - padding.bottom };
    image.drawText(font, box.x + 6, box.y + 2, this.title, 220);
    image.drawRect(box.x, box.y, box.width, box.height, 52);

    const wrapped = wrapText(font, this.body, box.width - 36);
    const step = lineStep(font);
    const bodyTop = box.y + 16 + font.lineHeight;
    const footerY = box.y + box.height - 36;
    const maxBodyLines = Math.max(0, Math.floor((footerY - bodyTop - 8) / step));
    for (let index = 0; index < Math.min(wrapped.length, maxBodyLines); index++) {
      image.drawText(font, box.x + 12, bodyTop + index * step, wrapped[index]!, 190);
    }
    image.drawText(font, box.x + 12, footerY, `${GESTURE_DOUBLE_CLICK} back`, 110);
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") {
      ctx.stack.pop();
    }
  }
}
