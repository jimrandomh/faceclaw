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
    "    #  ",
    "   ##  ",
    "  ##   ",
    " ######",
    "   ##  ",
    "  ##   ",
    "  #    ",
  ], {
    "#": 255,
    " ": 0,
  },
);

const PHONE_ICON = imageFromAsciiArt(
  [
    " ###### ",
    " #//### ",
    " #//### ",
    " ###### ",
    " ###### ",
    " ###### ",
    " ###### ",
    " ###### ",
    " ###### ",
    " ###### ",
  ], {
    "#": 255,
    "/": 64,
    " ": 0,
  }
);

const GLASSES_ICON = imageFromAsciiArt(
  [
    " _       _ ",
    "#         #",
    "#         #",
    "#         #",
    "#         #",
    "####/ /####",
    "#___###___#",
    "#___# #___#",
    " ###   ### ",
    "           ",
  ], {
    "#": 255,
    "/": 192,
    "_": 32,
    " ": 0,
  }
);

const WATCH_ICON = imageFromAsciiArt(
  [
    "   //   ",
    "   //   ",
    "   //   ",
    "  ####  ",
    "  #!!#  ",
    "  #!!#  ",
    "  ####  ",
    "   //   ",
    "   //   ",
    "   //   ",
  ], {
    "#": 255,
    "!": 192,
    "/": 140,
    " ": 0,
  }
);

const RING_ICON = imageFromAsciiArt(
  [
    "  /###/  ",
    " /#####/ ",
    "/#     #/",
    "#       #",
    "#       #",
    "#       #",
    "/#     #/",
    " /#   #/ ",
    "  /###/  ",
    "         ",
  ], {
    "#": 255,
    "/": 96,
    " ": 0,
  },
);

/** A device with a battery indicator, for the dense style's icon labels. */
export type BatteryDevice = "phone" | "watch" | "glasses" | "ring";

const DEVICE_ICONS: Readonly<Record<BatteryDevice, GrayImage>> = {
  phone: PHONE_ICON,
  watch: WATCH_ICON,
  glasses: GLASSES_ICON,
  ring: RING_ICON,
};

export type DenseBatteryItem = { device: BatteryDevice; percent: number; charging: boolean };

/** Clear rows between the two indicators in a dense column. */
const DENSE_ROW_GAP = 2;
/** Clear columns between a device icon's slot and its gauge. */
const DENSE_ICON_GAP = 3;
const DENSE_COLUMN_GAP = 8;

/** Height of a dense block: two indicator rows and the gap between them. */
export const DENSE_BATTERY_BLOCK_HEIGHT = 2 * ICON_HEIGHT + DENSE_ROW_GAP;

/**
 * Dense style: each device's icon to the left of its gauge, two indicators
 * stacked per column, columns right-aligned at `right` with `top` the upper
 * row's top edge. Columns pair from the right, so an odd count leaves the
 * first indicator alone in the leftmost column, centered vertically. Within
 * a column the gauges line up and each icon is centered in a slot as wide as
 * the column's widest icon. Returns the block's left edge (`right` when there
 * are no items).
 */
export function drawDenseBatteries(
  image: GrayImage,
  items: readonly DenseBatteryItem[],
  right: number,
  top: number,
): number {
  if (!items.length) return right;
  let x = right;
  for (let end = items.length; end > 0; end -= 2) {
    const column = items.slice(Math.max(0, end - 2), end);
    const slotWidth = Math.max(...column.map((item) => DEVICE_ICONS[item.device].width));
    x -= slotWidth + DENSE_ICON_GAP + BATTERY_ICON_WIDTH;
    const firstRowTop = column.length === 2 ? top : top + (((DENSE_BATTERY_BLOCK_HEIGHT - ICON_HEIGHT) / 2) | 0);
    for (let row = 0; row < column.length; row++) {
      const item = column[row]!;
      const rowTop = firstRowTop + row * (ICON_HEIGHT + DENSE_ROW_GAP);
      const icon = DEVICE_ICONS[item.device];
      image.bitBlt(icon, x + (((slotWidth - icon.width) / 2) | 0), rowTop, { transparentZero: true });
      image.bitBlt(drawBattery(item.percent, item.charging), x + slotWidth + DENSE_ICON_GAP, rowTop, {
        transparentZero: true,
      });
    }
    x -= DENSE_COLUMN_GAP;
  }
  return x + DENSE_COLUMN_GAP;
}

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
