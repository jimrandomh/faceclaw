import { GrayImage, imageFromAsciiArt } from "./image";

const EMPTY_BATTERY_ICON = imageFromAsciiArt(
  [
    " ##################  ",
    " #................#  ",
    " #................###",
    " #................###",
    " #................###",
    " #................###",
    " #................###",
    " #................###",
    " #................#  ",
    " ##################  ",
  ],
  120,
);

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

export const BATTERY_ICON_WIDTH = EMPTY_BATTERY_ICON.width;

const BATTERY_FILL_X = 3;
const BATTERY_FILL_Y = 2;
const BATTERY_FILL_WIDTH = 14;
const BATTERY_FILL_HEIGHT = 6;

export function drawBattery(percentCharge: number, isCharging: boolean): GrayImage {
  const icon = new GrayImage(EMPTY_BATTERY_ICON.width, EMPTY_BATTERY_ICON.height, 0);
  icon.bitBlt(EMPTY_BATTERY_ICON, 0, 0);
  const clamped = Math.max(0, Math.min(100, percentCharge));
  const fillWidth = Math.round((BATTERY_FILL_WIDTH * clamped) / 100);
  icon.fillRect(BATTERY_FILL_X, BATTERY_FILL_Y, fillWidth, BATTERY_FILL_HEIGHT, 190);
  if (isCharging) {
    overlayImage(icon, BATTERY_BOLT_ICON, 7, 1);
  }
  return icon;
}

function overlayImage(target: GrayImage, source: GrayImage, dx: number, dy: number): void {
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const value = source.pixels[y * source.width + x] ?? 0;
      if (value > 0) {
        target.setPixel(dx + x, dy + y, value);
      }
    }
  }
}
