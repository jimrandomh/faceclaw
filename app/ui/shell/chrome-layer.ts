import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { truncateText } from "../../graphics/textwrap";
import { activeAmbientCards } from "./ambient-cards";
import { BATTERY_ICON_WIDTH, drawBattery } from "../../graphics/battery";
import { readActiveNotificationIcons } from "../../native/notification-icons";
import { readPhoneBatteryState } from "../../native/phone-battery";
import { noteStaleDataUsed, renderPassAllowsStaleData } from "../../util/render-freshness";
import { renderIcon, renderIconWithGlyph, type IconName } from "../../graphics/icons";
import { batteryDisplayModeSetting, timeFormatSetting } from "../dashboard-settings";
import { Layer } from "../layers";
import { scrollToKeepSelectionVisible } from "../menu";
import { lineStep } from "../metrics";
import {
  MIN_WINDOW_HEIGHT,
  minWindowTop,
  SHELL_OPAQUE_BLACK,
  SIDEBAR_WIDTH,
  sidebarStripVisible,
  TOP_BAR_HEIGHT,
  windowTop,
  type WindowHeightMode,
} from "./geometry";

/**
 * Sidebar icon layout comes in two variants. Few enough windows for a single
 * column keeps the roomy 36px slots (32px icons) right-aligned against the
 * separator; past one column's worth it switches to two 32px slots (28px
 * icons) that exactly fill the 64px sidebar. In the two-column variant the
 * right column (against the app area) fills first and windows past that
 * overflow into the left column, so the common case keeps every icon next to
 * the content it belongs to.
 */
type SidebarVariant = { columns: number; columnWidth: number; iconSize: number };
const ONE_COLUMN: SidebarVariant = { columns: 1, columnWidth: 36, iconSize: 32 };
const TWO_COLUMN: SidebarVariant = { columns: 2, columnWidth: 32, iconSize: 28 };

const ICON_SPACING = 8;
/** Icon list top/bottom margins within the sidebar band, below the top bar. */
const LIST_MARGIN = 10;
const LIST_HEIGHT = MIN_WINDOW_HEIGHT - TOP_BAR_HEIGHT - 2 * LIST_MARGIN;

/** Icon rows that fit in one sidebar column. */
function rowsPerColumn(variant: SidebarVariant): number {
  return Math.max(1, ((LIST_HEIGHT + ICON_SPACING) / (variant.iconSize + ICON_SPACING)) | 0);
}

function sidebarVariant(windowCount: number): SidebarVariant {
  return windowCount > rowsPerColumn(ONE_COLUMN) ? TWO_COLUMN : ONE_COLUMN;
}

/** Left x of a sidebar column; columns pack rightward against the separator. */
function columnLeft(variant: SidebarVariant, column: number): number {
  return SIDEBAR_WIDTH - (variant.columns - column) * variant.columnWidth;
}

/**
 * Column and top y of a visible sidebar slot; `position` counts from the
 * first visible (scrolled-to) icon. Slots fill the rightmost column top to
 * bottom, then overflow leftward. The single source of slot geometry for
 * both drawing and hit testing.
 */
function slotPosition(variant: SidebarVariant, listTop: number, position: number): { column: number; y: number } {
  const rows = rowsPerColumn(variant);
  return {
    column: variant.columns - 1 - ((position / rows) | 0),
    y: listTop + (position % rows) * (variant.iconSize + ICON_SPACING),
  };
}

/** Top y of the sidebar's icon list (below the band's top bar). */
function sidebarListTop(): number {
  return minWindowTop() + TOP_BAR_HEIGHT + LIST_MARGIN;
}

/**
 * Left edge of the sidebar region that actually holds icons: the one-column
 * variant leaves a dead strip left of its single right-aligned column.
 * Screenshot cropping uses this to trim the unused part.
 */
export function sidebarContentLeft(windowCount: number): number {
  return columnLeft(sidebarVariant(windowCount), 0);
}
const NOTIFICATION_ICON_SIZE = 24;
const BORDER_VALUE = 40;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type ShellChromeWindow = {
  windowId: string;
  title: string;
  attention: boolean;
  /** Draw the window's indicator icon. inverted = black-on-white (focused tab). */
  drawIcon: (image: GrayImage, x: number, y: number, size: number, inverted?: boolean) => void;
};

export type ShellChromeState = {
  windows: ShellChromeWindow[];
  selectedIndex: number;
  focus: "sidebar" | "window";
  /** Height mode of the foreground window; decides where its top bar sits. */
  foregroundHeightMode: WindowHeightMode;
  battery: { headset: number | null; headsetCharging: boolean | null };
  /** App-provided tray images, drawn between notification icons and batteries. */
  trayIcons: GrayImage[];
};

/** Placeholder window icon: rounded outline with a single letter. */
export function makeLetterWindowIcon(letter: string): ShellChromeWindow["drawIcon"] {
  return (image, x, y, size, inverted) => {
    const font = getDefaultMediumFont();
    if (!inverted) {
      image.drawRoundedRect(x, y, size, size, 120, 6);
    }
    const textX = x + Math.max(0, ((size - font.measureText(letter)) / 2) | 0);
    const textY = y + Math.max(0, ((size - font.lineHeight) / 2) | 0);
    image.drawText(font, textX, textY, letter, inverted ? SHELL_OPAQUE_BLACK : 210);
  };
}

/**
 * Inverted (black-on-white) variant of an icon raster, for the focused tab:
 * coverage becomes darkness, with full coverage mapping to SHELL_OPAQUE_BLACK
 * (1) rather than 0, since 0 is the surface's transparent color key. Memoized
 * per source object so the variant is a stable image the texture cache can
 * key on (mode-13's inverse LUT can't reproduce this mapping exactly, so it
 * is simply a separate cached image).
 */
const invertedIconCache = new WeakMap<GrayImage, GrayImage>();
function invertedIcon(icon: GrayImage): GrayImage {
  let inverted = invertedIconCache.get(icon);
  if (!inverted) {
    inverted = new GrayImage(icon.width, icon.height, 0);
    for (let i = 0; i < icon.pixels.length; i++) {
      const coverage = icon.pixels[i]!;
      if (coverage > 0) {
        inverted.pixels[i] = Math.max(SHELL_OPAQUE_BLACK, 255 - coverage);
      }
    }
    invertedIconCache.set(icon, inverted);
  }
  return inverted;
}

/** Window icon rendered from an SVG (Lucide), rendered once per size and cached. */
export function makeSvgWindowIcon(name: IconName, glyph?: string): ShellChromeWindow["drawIcon"] {
  return (image, x, y, size, inverted) => {
    const icon = glyph ? renderIconWithGlyph(name, glyph, size) : renderIcon(name, size);
    if (!icon) return;
    const dx = x + Math.max(0, ((size - icon.width) / 2) | 0);
    const dy = y + Math.max(0, ((size - icon.height) / 2) | 0);
    image.drawImage(inverted ? invertedIcon(icon) : icon, dx, dy);
  };
}

/** SVG icon when a name is given, else the letter placeholder. */
export function windowIcon(icon: IconName | undefined, letter: string, glyph?: string): ShellChromeWindow["drawIcon"] {
  return icon ? makeSvgWindowIcon(icon, glyph) : makeLetterWindowIcon(letter);
}

/** Window icon backed by an arbitrary cached grayscale image renderer. */
export function makeImageWindowIcon(
  render: (size: number) => GrayImage | null,
  fallback: ShellChromeWindow["drawIcon"],
): ShellChromeWindow["drawIcon"] {
  return (image, x, y, size, inverted) => {
    const icon = render(size);
    if (!icon) {
      fallback(image, x, y, size, inverted);
      return;
    }
    const dx = x + Math.max(0, ((size - icon.width) / 2) | 0);
    const dy = y + Math.max(0, ((size - icon.height) / 2) | 0);
    image.drawImage(inverted ? invertedIcon(icon) : icon, dx, dy);
  };
}

/**
 * Base layer of the shell surface: the window sidebar on the left and the
 * status top bar. Everything not explicitly painted stays 0 (transparent on
 * the color-key shell surface), so the app viewport shows through.
 */
export class ShellChromeLayer implements Layer {
  // First sidebar row shown; adjusted each paint to keep the selection visible.
  private scrollRow = 0;

  constructor(private readonly getState: () => ShellChromeState) {}

  paint(): GrayImage {
    const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    const state = this.getState();
    // Full-panel mode: the strip is an overlay, present only while the user
    // is in it (the window underneath keeps its full width the rest of the time).
    if (sidebarStripVisible(state.focus)) {
      this.drawSidebar(image, state);
    }
    this.drawTopBar(image, state);
    drawAmbientCards(image);
    return image;
  }

  handleInput(): void {
    // Shell input is handled by the shell state machine before it reaches the
    // layer stack; the chrome itself never consumes events.
  }

  /**
   * Which window's sidebar icon is under (x, y) on screen, if any — the same
   * slot geometry drawSidebar uses, so a touch on the phone's mirror lands on
   * the icon the mirror showed.
   */
  windowIndexAt(x: number, y: number, windowCount: number): number | null {
    if (x < 0 || x >= SIDEBAR_WIDTH || windowCount === 0) return null;
    const variant = sidebarVariant(windowCount);
    const listTop = sidebarListTop();
    const lastVisible = Math.min(windowCount, this.scrollRow + rowsPerColumn(variant) * variant.columns);
    for (let index = this.scrollRow; index < lastVisible; index++) {
      const { column, y: slotY } = slotPosition(variant, listTop, index - this.scrollRow);
      const left = columnLeft(variant, column);
      if (x >= left && x < left + variant.columnWidth && y >= slotY - 2 && y < slotY + variant.iconSize + 2) {
        return index;
      }
    }
    return null;
  }

  private drawSidebar(image: GrayImage, state: ShellChromeState): void {
    // The sidebar always occupies the min-height window band at the preferred
    // vertical position: it never moves when the foreground window's height
    // changes, and it lines up exactly with a min-height window's chrome.
    const bandTop = minWindowTop();
    const bandBottom = bandTop + MIN_WINDOW_HEIGHT;
    image.fillRect(0, bandTop, SIDEBAR_WIDTH, MIN_WINDOW_HEIGHT, SHELL_OPAQUE_BLACK);

    // Scroll the icon list to keep the selection visible; chevrons mark
    // windows off-screen above/below. Icons fill the right column top to
    // bottom, then overflow into the left one, so a visible slot's column is
    // decided by its position within the scrolled window.
    const count = state.windows.length;
    const variant = sidebarVariant(count);
    const iconSize = variant.iconSize;
    const iconMarginX = ((variant.columnWidth - iconSize) / 2) | 0;
    // Column index of the rightmost column (the one that fills first).
    const firstColumn = variant.columns - 1;
    const listTop = sidebarListTop();
    const visibleCount = rowsPerColumn(variant) * variant.columns;
    this.scrollRow = scrollToKeepSelectionVisible(this.scrollRow, state.selectedIndex, visibleCount, count);
    const lastVisible = Math.min(count, this.scrollRow + visibleCount);
    const slotOf = (index: number) => slotPosition(variant, listTop, index - this.scrollRow);

    // The selection is a "diversion" of the sidebar/main separator line: the
    // line bulges right around the selected icon (rounded on the left, open
    // to the main area on the right), so the separator is drawn with a gap
    // there. When the sidebar has focus, the diversion is filled white and
    // the icon drawn inverted. Only the right column touches the separator;
    // a selected overflow icon gets a self-contained box instead.
    const sep = SIDEBAR_WIDTH - 1;
    const selVisible = state.selectedIndex >= this.scrollRow && state.selectedIndex < lastVisible;
    const selSlot = selVisible ? slotOf(state.selectedIndex) : null;
    const selTabTop = selSlot && selSlot.column === firstColumn ? selSlot.y - 2 : null;
    if (selTabTop !== null) {
      image.drawLine(sep, bandTop, sep, selTabTop, BORDER_VALUE);
      image.drawLine(sep, selTabTop + iconSize + 4, sep, bandBottom - 1, BORDER_VALUE);
    } else {
      image.drawLine(sep, bandTop, sep, bandBottom - 1, BORDER_VALUE);
    }

    for (let index = this.scrollRow; index < lastVisible; index++) {
      const window = state.windows[index]!;
      const { column, y } = slotOf(index);
      const left = columnLeft(variant, column);
      const x = left + iconMarginX;
      const selected = index === state.selectedIndex;
      const focused = selected && state.focus === "sidebar";
      if (selected && column === firstColumn) {
        drawSelectionTab(image, left, y - 2, y + iconSize + 2, focused);
      } else if (selected) {
        // Spans the full column: only 2px of margin flanks the icon in its
        // slot, so anything wider would clip at the screen edge.
        drawSelectionBox(image, left, y - 2, variant.columnWidth, iconSize + 4, focused);
      }
      window.drawIcon(image, x, y, iconSize, focused);
      if (window.attention) {
        // Black dot on the white focused tab, white dot otherwise. A deferred
        // image (not a raster fill) so it renders above the icon, which is
        // itself a deferred draw.
        image.drawImage(attentionDot(focused ? SHELL_OPAQUE_BLACK : 255), x + iconSize - 7, y - 1);
      }
    }

    // Chevrons center over the icon area, which in the one-column variant is
    // narrower than the sidebar strip.
    const chevronX = ((columnLeft(variant, 0) + SIDEBAR_WIDTH) / 2) | 0;
    if (this.scrollRow > 0) {
      drawChevron(image, chevronX, bandTop + TOP_BAR_HEIGHT + 6, -1);
    }
    if (lastVisible < count) {
      drawChevron(image, chevronX, bandBottom - 6, 1);
    }
  }

  private drawTopBar(image: GrayImage, state: ShellChromeState): void {
    const font = getDefaultMediumFont();
    // The bar sits at the top edge of the foreground window's band, wherever
    // its height mode puts that (screen top for max height). It moves when
    // the foreground switches to a window of a different height.
    const barTop = windowTop(state.foregroundHeightMode);
    // The bar spans the app viewport; with the sidebar overlaid (full-panel
    // mode, sidebar focused) it still starts past the strip.
    const barLeft = sidebarStripVisible(state.focus) ? SIDEBAR_WIDTH : 0;
    image.fillRect(barLeft, barTop, G2_LENS_WIDTH - barLeft, TOP_BAR_HEIGHT, SHELL_OPAQUE_BLACK);
    image.drawLine(barLeft, barTop + TOP_BAR_HEIGHT - 1, G2_LENS_WIDTH - 1, barTop + TOP_BAR_HEIGHT - 1, BORDER_VALUE);

    const now = new Date();
    const clock = `${WEEKDAYS[now.getDay()]} ${now.getDate()} ${MONTHS[now.getMonth()]} ` +
      formatClockTime(now);
    const clockX = barLeft + 10;
    const textY = barTop + Math.max(0, ((TOP_BAR_HEIGHT - font.lineHeight) / 2) | 0);
    image.drawText(font, clockX, textY, clock, 210);

    const batteryLeft = this.drawTopBarBatteries(image, state, barTop);
    const trayLeft = drawTrayIcons(image, state.trayIcons, batteryLeft, barTop);

    const iconsX = clockX + font.measureText(clock) + 16;
    const maxIcons = Math.max(0, ((trayLeft - 8 - iconsX) / (NOTIFICATION_ICON_SIZE + 4)) | 0);
    if (maxIcons > 0) {
      const { icons, stale } = readActiveNotificationIcons(maxIcons, renderPassAllowsStaleData());
      if (stale) {
        noteStaleDataUsed();
      }
      const iconY = barTop + (((TOP_BAR_HEIGHT - NOTIFICATION_ICON_SIZE) / 2) | 0);
      for (let index = 0; index < icons.length; index++) {
        image.drawImage(icons[index]!, iconsX + index * (NOTIFICATION_ICON_SIZE + 4), iconY);
      }
    }
  }

  /**
   * Labelled battery indicators for the phone and the G2, right-aligned in
   * the top bar, following the dashboard card's icon/percentage setting.
   * Returns the left edge of the battery block.
   */
  private drawTopBarBatteries(image: GrayImage, state: ShellChromeState, barTop: number): number {
    const font = getDefaultSmallFont();
    const percentageMode = batteryDisplayModeSetting.get() === "percentage";
    type BatteryItem = { label: string; percent: number; charging: boolean };
    const items: BatteryItem[] = [];
    const phone = readPhoneBatteryState();
    if (phone.battery !== null && Number.isFinite(phone.battery)) {
      items.push({ label: "Phone", percent: phone.battery, charging: Boolean(phone.charging) });
    }
    if (state.battery.headset !== null && Number.isFinite(state.battery.headset)) {
      items.push({ label: "G2", percent: state.battery.headset, charging: Boolean(state.battery.headsetCharging) });
    }
    if (!items.length) return G2_LENS_WIDTH;

    const labelGap = 5;
    const itemGap = 12;
    const textY = barTop + Math.max(0, ((TOP_BAR_HEIGHT - font.lineHeight) / 2) | 0);
    let x = G2_LENS_WIDTH - 8;
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index]!;
      const percentText = `${Math.max(0, Math.min(100, Math.round(item.percent)))}%`;
      const valueWidth = percentageMode ? font.measureText(percentText) : BATTERY_ICON_WIDTH;
      const labelWidth = font.measureText(item.label);
      x -= labelWidth + labelGap + valueWidth;
      image.drawText(font, x, textY, item.label, 150);
      const valueX = x + labelWidth + labelGap;
      if (percentageMode) {
        if (item.charging) {
          // Inverted text marks charging, matching the dashboard card.
          image.fillRect(valueX - 2, textY - 1, valueWidth + 4, font.lineHeight + 2, 255);
          image.drawText(font, valueX, textY, percentText, 1);
        } else {
          image.drawText(font, valueX, textY, percentText, 200);
        }
      } else {
        const icon = drawBattery(item.percent, item.charging);
        image.bitBlt(icon, valueX, barTop + Math.max(0, ((TOP_BAR_HEIGHT - icon.height) / 2) | 0), {
          transparentZero: true,
        });
      }
      x -= itemGap;
    }
    return x + itemGap;
  }
}

// Ambient cards (encounter popups): compact and deliberately unobtrusive,
// anchored to the bottom-right of the window band and stacking upward, clear
// of the caption area's left-aligned text. Never interactive.
const AMBIENT_CARD_WIDTH = 230;
const AMBIENT_CARD_MARGIN = 6;
const AMBIENT_CARD_GAP = 4;
const AMBIENT_CARD_PADDING_X = 8;
const AMBIENT_CARD_PADDING_Y = 4;
const AMBIENT_MAX_LINES_PER_CARD = 3;

/**
 * Paint the active ambient cards bottom-up: the oldest card sits at the very
 * bottom of the window band and newer ones stack above it. Cards that would
 * cross into the top bar are dropped rather than clipped.
 */
function drawAmbientCards(image: GrayImage): void {
  const cards = activeAmbientCards();
  if (!cards.length) return;
  const font = getDefaultSmallFont();
  const bandTop = minWindowTop();
  const bandBottom = bandTop + MIN_WINDOW_HEIGHT;
  const x = G2_LENS_WIDTH - AMBIENT_CARD_WIDTH - AMBIENT_CARD_MARGIN;
  const textWidth = AMBIENT_CARD_WIDTH - 2 * AMBIENT_CARD_PADDING_X;
  let bottom = bandBottom - AMBIENT_CARD_MARGIN;
  for (const card of cards) {
    const lines = [card.title, ...card.lines].slice(0, 1 + AMBIENT_MAX_LINES_PER_CARD);
    const height = 2 * AMBIENT_CARD_PADDING_Y + lines.length * lineStep(font);
    const y = bottom - height;
    if (y < bandTop + TOP_BAR_HEIGHT) break;
    image.fillRoundedRect(x, y, AMBIENT_CARD_WIDTH, height, SHELL_OPAQUE_BLACK, 6);
    image.drawRoundedRect(x, y, AMBIENT_CARD_WIDTH, height, 90, 6);
    for (let index = 0; index < lines.length; index++) {
      image.drawText(
        font,
        x + AMBIENT_CARD_PADDING_X,
        y + AMBIENT_CARD_PADDING_Y + index * lineStep(font),
        truncateText(font, lines[index]!, textWidth),
        index === 0 ? 220 : 160,
      );
    }
    bottom = y - AMBIENT_CARD_GAP;
  }
}

/**
 * Draw app tray icons right-to-left, ending just left of the battery block;
 * returns the left edge of the tray region.
 */
function drawTrayIcons(image: GrayImage, trayIcons: GrayImage[], rightEdge: number, barTop: number): number {
  let x = rightEdge;
  for (let index = trayIcons.length - 1; index >= 0; index--) {
    const icon = trayIcons[index]!;
    x -= icon.width + 10;
    image.drawImage(icon, x, barTop + Math.max(0, ((TOP_BAR_HEIGHT - icon.height) / 2) | 0));
  }
  return x;
}

/** The sidebar attention marker, cached per fill value (deferred-image source). */
const attentionDots = new Map<number, GrayImage>();
function attentionDot(value: number): GrayImage {
  let dot = attentionDots.get(value);
  if (!dot) {
    dot = new GrayImage(8, 8, 0);
    dot.fillRoundedRect(0, 0, 8, 8, value, 4);
    attentionDots.set(value, dot);
  }
  return dot;
}

const TAB_RADIUS = 6;
// How far the diversion pokes past the separator into the main area.
const TAB_EXTEND = 1;
const TAB_STROKE = 150;

/**
 * Draw the selection "diversion" of the separator line around a sidebar icon
 * in the rightmost column: rounded on the left, square and open on the right,
 * extending a few px past the separator into the main area. Focused = filled
 * white; otherwise an outline. `left` is the column's left edge, which the
 * rounded corners curve in from.
 */
function drawSelectionTab(image: GrayImage, left: number, top: number, bottom: number, focused: boolean): void {
  const right = SIDEBAR_WIDTH - 1 + TAB_EXTEND;
  if (focused) {
    for (let yy = top; yy < bottom; yy++) {
      const x = left + tabLeftInset(yy, top, bottom, TAB_RADIUS);
      image.fillRect(x, yy, right - x + 1, 1, 255);
    }
    return;
  }
  // Outline: the tab shape minus the same shape inset by a pixel, row by row.
  // Stroking the curve one pixel per row instead would leave gaps wherever the
  // corner steps in by more than one pixel, and the top/bottom edges have to
  // start at the same inset the curve uses or they part company from it.
  for (let yy = top; yy < bottom; yy++) {
    const outer = left + tabLeftInset(yy, top, bottom, TAB_RADIUS);
    // The top and bottom rows are the horizontal edges: solid out to the open
    // right side. In between only the left edge is stroked.
    const inner = yy > top && yy < bottom - 1
      ? left + 1 + tabLeftInset(yy, top + 1, bottom - 1, TAB_RADIUS - 1)
      : right + 1;
    image.fillRect(outer, yy, Math.max(1, Math.min(inner, right + 1) - outer), 1, TAB_STROKE);
  }
}

/**
 * Selection marker for an overflow-column icon, which has no separator to
 * divert: a self-contained rounded box, filled white when the sidebar has
 * focus and outlined otherwise (matching the tab's two states).
 */
function drawSelectionBox(image: GrayImage, x: number, y: number, width: number, height: number, focused: boolean): void {
  if (focused) {
    image.fillRoundedRect(x, y, width, height, 255, TAB_RADIUS);
  } else {
    image.drawRoundedRect(x, y, width, height, TAB_STROKE, TAB_RADIUS);
  }
}

/** Left boundary x of the tab at row yy: 0 in the middle, curving to the rounded left corners. */
function tabLeftInset(yy: number, top: number, bottom: number, radius: number): number {
  const cy = yy + 0.5;
  let dy = 0;
  if (cy < top + radius) {
    dy = top + radius - cy;
  } else if (cy > bottom - radius) {
    dy = cy - (bottom - radius);
  } else {
    return 0;
  }
  return Math.max(0, Math.round(radius - Math.sqrt(Math.max(0, radius * radius - dy * dy))));
}

/** Format the top-bar clock time, honoring the 12/24-hour setting. */
function formatClockTime(now: Date): string {
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const hour24 = now.getHours();
  if (timeFormatSetting.get() === "12h") {
    const hour12 = ((hour24 + 11) % 12) + 1;
    return `${hour12}:${minutes} ${hour24 < 12 ? "AM" : "PM"}`;
  }
  return `${hour24}:${minutes}`;
}

/** Small triangle marker for sidebar overflow; direction -1 = up, 1 = down. */
function drawChevron(image: GrayImage, centerX: number, y: number, direction: -1 | 1): void {
  const half = 5;
  const tipY = direction < 0 ? y - 3 : y + 3;
  image.drawLine(centerX - half, y, centerX, tipY, 140);
  image.drawLine(centerX, tipY, centerX + half, y, 140);
}
