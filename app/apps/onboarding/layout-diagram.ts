/**
 * Schematic diagrams of the shell's layouts for the onboarding's Layout
 * page: to scale in real-display pixels, simplified, and drawn brighter
 * than the real chrome, which they shrink to a few pixels.
 */
import { G2_LENS_WIDTH, type GrayImage } from "../../graphics/image";
import { statusBarPositionSetting, type AppSwitcherPosition } from "../../ui/dashboard-settings";
import { SIDEBAR_WIDTH, SWITCHER_ROW_HEIGHT, MIN_WINDOW_HEIGHT, TOP_BAR_HEIGHT } from "../../ui/shell/geometry";

export const AREA_OUTLINE = 30;
const CHROME_LINE = 100;
const WINDOW_FRAME = 140;
const ICON = 160;
const SELECTED_ICON = 230;
const STATUS = 140;
const CONTENT = 110;
const CONTENT_TITLE = 170;
/** Window content under a popup switcher, which dims it. */
const DIM = 0.5;

/** Draws in real-display pixels, scaled into an image at (x, y). */
export class Diagram {
  constructor(
    private readonly image: GrayImage,
    private readonly x: number,
    private readonly y: number,
    private readonly scale: number,
  ) {}

  private box(x: number, y: number, width: number, height: number) {
    const left = this.x + Math.round(x * this.scale), top = this.y + Math.round(y * this.scale);
    return {
      x: left,
      y: top,
      width: Math.max(1, this.x + Math.round((x + width) * this.scale) - left),
      height: Math.max(1, this.y + Math.round((y + height) * this.scale) - top),
    };
  }

  fill(x: number, y: number, width: number, height: number, value: number, radius = 0): void {
    const box = this.box(x, y, width, height);
    if (radius) this.image.fillRoundedRect(box.x, box.y, box.width, box.height, value, Math.max(1, Math.round(radius * this.scale)));
    else this.image.fillRect(box.x, box.y, box.width, box.height, value);
  }

  outline(x: number, y: number, width: number, height: number, value: number, radius = 0): void {
    const box = this.box(x, y, width, height);
    this.image.drawRoundedRect(box.x, box.y, box.width, box.height, value, Math.max(0, Math.round(radius * this.scale)));
  }

  /** A one-pixel line along a real-pixel row (horizontal) or column. */
  hline(x: number, y: number, width: number, value: number): void {
    const box = this.box(x, y, width, 1);
    this.image.fillRect(box.x, box.y, box.width, 1, value);
  }

  vline(x: number, y: number, height: number, value: number): void {
    const box = this.box(x, y, 1, height);
    this.image.fillRect(box.x, box.y, 1, box.height, value);
  }
}

/**
 * The foreground window's band, in real-display rows: its top and height
 * (header and content; a bottom switcher row hangs under it), and whether
 * it spans the panel's whole width (Full Screen; never beside a side strip).
 */
export type DiagramBand = { top: number; height: number; fullWidth: boolean };

/**
 * A layout as the real chrome lays it out (geometry.ts, chrome-layer.ts):
 * the window band with its status bar and frame, and the switcher with a
 * few icons, the first selected. A popup switcher shows only with
 * `popupOpen`, dimming the window as it does. Status bar placement follows
 * the current setting.
 */
export function drawLayout(d: Diagram, position: AppSwitcherPosition, band: DiagramBand, popupOpen: boolean): void {
  const statusAtBottom = statusBarPositionSetting.get() === "bottom";
  const { top, height } = band;
  switch (position) {
    case "left":
    case "right": {
      const stripLeft = position === "left" ? 0 : G2_LENS_WIDTH - SIDEBAR_WIDTH;
      const contentLeft = position === "left" ? SIDEBAR_WIDTH : 0;
      const windowWidth = G2_LENS_WIDTH - SIDEBAR_WIDTH;
      drawStatusBar(d, contentLeft, top, windowWidth, TOP_BAR_HEIGHT - 1);
      drawContent(d, contentLeft, top + TOP_BAR_HEIGHT, windowWidth, height - TOP_BAR_HEIGHT, 1);
      // The strip keeps to the 288px band's height, even beside taller windows.
      const separator = position === "left" ? SIDEBAR_WIDTH - 1 : stripLeft;
      d.vline(separator, top + TOP_BAR_HEIGHT, MIN_WINDOW_HEIGHT - TOP_BAR_HEIGHT, CHROME_LINE);
      // One column of icons against the separator.
      const column = position === "left" ? SIDEBAR_WIDTH - 36 : stripLeft;
      for (let slot = 0; slot < 4; slot++) drawIcon(d, column + 2, top + TOP_BAR_HEIGHT + 10 + slot * 40, slot === 0);
      return;
    }
    case "bottom": {
      const { left, width, framed } = windowSpan(band);
      // With the status bar in the row, the window's header is just the frame's top.
      const header = !statusAtBottom ? TOP_BAR_HEIGHT : framed ? 1 : 0;
      if (!statusAtBottom) drawStatusBar(d, left, top, width, framed ? null : TOP_BAR_HEIGHT - 1);
      drawContent(d, left, top + header, width, height - header, 1);
      if (framed) d.outline(left - 1, top + header - 1, width + 2, height - header + 2, WINDOW_FRAME, 8);
      else d.hline(left, top + height, width, CHROME_LINE);
      // The first cell starts at the frame's side, or inset like a scrolled row's (chrome-layer switcherLayout).
      const cellsLeft = framed ? left - 1 : left + 8;
      for (let slot = 0; slot < 4; slot++) drawIcon(d, cellsLeft + 2 + slot * 40, top + height + 2, slot === 0);
      if (statusAtBottom) drawStatusItems(d, left + width, top + height + 4);
      return;
    }
    case "popup": {
      const { left, width, framed } = windowSpan(band);
      const edge = framed ? 1 : 0;
      const statusTop = statusAtBottom ? top + height - TOP_BAR_HEIGHT : top;
      const contentTop = statusAtBottom ? top + edge : top + TOP_BAR_HEIGHT;
      const contentHeight = height - TOP_BAR_HEIGHT - edge;
      drawStatusBar(d, left, statusTop, width, framed ? null : statusAtBottom ? 0 : TOP_BAR_HEIGHT - 1);
      drawContent(d, left, contentTop, width, contentHeight, popupOpen ? DIM : 1);
      if (framed) d.outline(left - 1, contentTop - 1, width + 2, contentHeight + 2, WINDOW_FRAME, 8);
      if (!popupOpen) return;
      // The popup: a row of icons over the selected window's title, centred on the content.
      const box = { width: 272, height: 98 };
      const boxLeft = left + (width - box.width) / 2;
      const boxTop = contentTop + (contentHeight - box.height) / 2;
      d.fill(boxLeft, boxTop, box.width, box.height, 0);
      d.outline(boxLeft, boxTop, box.width, box.height, WINDOW_FRAME);
      const iconsLeft = boxLeft + (box.width - (3 * 48 - 4)) / 2;
      for (let slot = 0; slot < 3; slot++) drawIcon(d, iconsLeft + slot * 48 + 6, boxTop + 18, slot === 0);
      d.fill(boxLeft + box.width / 2 - 50, boxTop + 70, 100, 12, STATUS, 6);
      return;
    }
  }
}

/** A bottom row or popup layout's window: centred at 576 wide and framed, or the panel's width without a frame. */
function windowSpan(band: DiagramBand): { left: number; width: number; framed: boolean } {
  return band.fullWidth
    ? { left: 0, width: G2_LENS_WIDTH, framed: false }
    : { left: SIDEBAR_WIDTH / 2, width: G2_LENS_WIDTH - SIDEBAR_WIDTH, framed: true };
}

/**
 * A status bar's 28 rows from `y`; `divider` is the row (within them) of its
 * line toward the window, if it draws one rather than meeting a frame.
 */
function drawStatusBar(d: Diagram, x: number, y: number, width: number, divider: number | null): void {
  if (divider !== null) d.hline(x, y + divider, width, CHROME_LINE);
  drawStatusItems(d, x + width, y);
}

/** Notification icons, a battery and the clock, ending at `right`, in a status bar's 28 rows from `top`. */
function drawStatusItems(d: Diagram, right: number, top: number): void {
  d.fill(right - 64, top + 7, 56, 14, STATUS, 4);
  d.outline(right - 108, top + 8, 32, 12, STATUS, 2);
  d.outline(right - 148, top + 4, 20, 20, CHROME_LINE, 4);
  d.outline(right - 176, top + 4, 20, 20, CHROME_LINE, 4);
}

/** A switcher icon (32px); the selected one filled, as the switcher's selection tab is. */
function drawIcon(d: Diagram, x: number, y: number, selected: boolean): void {
  if (selected) d.fill(x, y, 32, 32, SELECTED_ICON, 6);
  else d.outline(x, y, 32, 32, ICON, 6);
}

/** Stand-in window content: a title and as many list rows as fit, the first selected. */
function drawContent(d: Diagram, x: number, y: number, width: number, height: number, brightness: number): void {
  const rowWidths = [width - 60, 300, 360, 240];
  d.fill(x + 18, y + 14, 150, 18, Math.round(CONTENT_TITLE * brightness), 6);
  d.outline(x + 8, y + 44, width - 16, 34, Math.round(CONTENT * brightness), 8);
  for (let row = 0; ; row++) {
    const rowTop = y + 52 + row * 44;
    if (rowTop + 18 > y + height - 8) break;
    d.fill(x + 18, rowTop, Math.min(rowWidths[row % rowWidths.length]!, width - 36), 18, Math.round(CONTENT * brightness), 6);
  }
}

/** Real-display rows the Layout page's diagrams cover: a 288px band and a bottom switcher row under it. */
export const LAYOUT_AREA_HEIGHT = MIN_WINDOW_HEIGHT + SWITCHER_ROW_HEIGHT;
