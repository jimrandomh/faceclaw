import { GrayImage } from "./image";
import { decodeBase64 } from "../util/base64";
import { PEBBLE_ICON_DATA, PEBBLE_ICON_SIZE, type PebbleIconName } from "./pebble-icons-data";

export { PEBBLE_ICON_SIZE, type PebbleIconName };

// 2-bit codes in pebble-icons-data.ts -> coverage.
const LEVELS = [0, 128, 255, 255];

const cache = new Map<PebbleIconName, GrayImage>();

/**
 * One of the bundled Pebble notification icons (see pebble-icons-data.ts and
 * scripts/generate-pebble-icons.cjs), as a PEBBLE_ICON_SIZE square coverage
 * bitmap. Decoded once and shared: clone it before drawing on it.
 */
export function pebbleIcon(name: PebbleIconName): GrayImage {
  let icon = cache.get(name);
  if (!icon) {
    const bytes = decodeBase64(PEBBLE_ICON_DATA[name]);
    icon = new GrayImage(PEBBLE_ICON_SIZE, PEBBLE_ICON_SIZE, 0);
    for (let i = 0; i < icon.pixels.length; i++) {
      icon.pixels[i] = LEVELS[(bytes[i >> 2]! >> (6 - 2 * (i & 3))) & 3]!;
    }
    cache.set(name, icon);
  }
  return icon;
}
