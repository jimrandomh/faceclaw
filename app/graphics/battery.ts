import { GrayImage, imageFromAsciiArt } from "./image";

/**
 * Top-bar battery gauge: a 10px-tall outlined body with a nub on the right,
 * filled left-to-right in proportion to the charge. The fill is drawn as
 * BATTERY_BAR_COUNT bars of BATTERY_BAR_WIDTH px separated by dimmed
 * BATTERY_BAR_GAP-px columns; the body outline is sized from those
 * constants so they can be tuned freely. The fill level is continuous (not
 * quantized to whole bars): the rightmost lit bar is cut to a partial width.
 */
export const BATTERY_BAR_COUNT = 4;
export const BATTERY_BAR_WIDTH = 3;
export const BATTERY_BAR_GAP = 1;

const OUTLINE_VALUE = 120;
const BAR_VALUE = 190;
/** The separator columns inside the lit portion of the fill. */
const BAR_GAP_VALUE = 70;

const ICON_HEIGHT = 10;
/** Outline stroke plus one clear pixel between it and the fill, per side. */
const BODY_INSET = 2;
const NUB_WIDTH = 2;
const NUB_TOP = 2;
const NUB_HEIGHT = 6;

const FILL_X = BODY_INSET;
const FILL_Y = BODY_INSET;
const FILL_WIDTH = BATTERY_BAR_COUNT * BATTERY_BAR_WIDTH + (BATTERY_BAR_COUNT - 1) * BATTERY_BAR_GAP;
const FILL_HEIGHT = ICON_HEIGHT - 2 * BODY_INSET;
const BODY_WIDTH = FILL_WIDTH + 2 * BODY_INSET;

export const BATTERY_ICON_WIDTH = BODY_WIDTH + NUB_WIDTH;

const BATTERY_BOLT_ICON = imageFromAsciiArt(
  [
    "....#..",
    "...##..",
    "..##...",
    ".######",
    "...##..",
    "..##...",
    "..#....",
  ],
  255,
);

/** The empty outline, built once from the geometry constants. */
const EMPTY_BATTERY_ICON = buildEmptyBattery();

function buildEmptyBattery(): GrayImage {
  const icon = new GrayImage(BATTERY_ICON_WIDTH, ICON_HEIGHT, 0);
  icon.fillRect(0, 0, BODY_WIDTH, 1, OUTLINE_VALUE);
  icon.fillRect(0, ICON_HEIGHT - 1, BODY_WIDTH, 1, OUTLINE_VALUE);
  icon.fillRect(0, 0, 1, ICON_HEIGHT, OUTLINE_VALUE);
  icon.fillRect(BODY_WIDTH - 1, 0, 1, ICON_HEIGHT, OUTLINE_VALUE);
  icon.fillRect(BODY_WIDTH, NUB_TOP, NUB_WIDTH, NUB_HEIGHT, OUTLINE_VALUE);
  return icon;
}

export function drawBattery(percentCharge: number, isCharging: boolean): GrayImage {
  const icon = new GrayImage(EMPTY_BATTERY_ICON.width, EMPTY_BATTERY_ICON.height, 0);
  icon.bitBlt(EMPTY_BATTERY_ICON, 0, 0);
  const clamped = Math.max(0, Math.min(100, percentCharge));
  const litWidth = Math.round((FILL_WIDTH * clamped) / 100);
  drawSegmentedFill(icon, litWidth);
  if (isCharging) {
    const boltX = FILL_X + (((FILL_WIDTH - BATTERY_BOLT_ICON.width) / 2) | 0);
    overlayImage(icon, BATTERY_BOLT_ICON, boltX, 1, clamped > 50 ? 0 : 255);
  }
  return icon;
}

/**
 * Light the leftmost `litWidth` columns of the fill area as bars with dim
 * separator columns. Columns past the lit width stay clear, so a partial
 * charge ends mid-bar rather than snapping to a bar boundary. A separator is
 * only drawn between two lit bars: when the lit width ends exactly on one it
 * is left clear rather than dangling past the last bar.
 */
function drawSegmentedFill(icon: GrayImage, litWidth: number): void {
  const pitch = BATTERY_BAR_WIDTH + BATTERY_BAR_GAP;
  for (let column = 0; column < litWidth; column++) {
    const isBar = column % pitch < BATTERY_BAR_WIDTH;
    if (!isBar && column + BATTERY_BAR_GAP >= litWidth) continue;
    icon.fillRect(FILL_X + column, FILL_Y, 1, FILL_HEIGHT, isBar ? BAR_VALUE : BAR_GAP_VALUE);
  }
}

function overlayImage(target: GrayImage, source: GrayImage, dx: number, dy: number, value: number): void {
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const sourceValue = source.pixels[y * source.width + x] ?? 0;
      if (sourceValue > 0) {
        target.setPixel(dx + x, dy + y, value);
      }
    }
  }
}
