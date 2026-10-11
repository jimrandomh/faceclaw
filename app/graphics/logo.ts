import { GrayImage } from "./image";
import { loadPngAsGrayImage } from "./imagefile";

let cachedDashboardLogo: GrayImage | null | undefined;

export function getDashboardLogo(): GrayImage | null {
  if (cachedDashboardLogo !== undefined) {
    return cachedDashboardLogo;
  }
  try {
    cachedDashboardLogo = loadPngAsGrayImage("images/faceclaw-logo-dashboard.png");
  } catch {
    cachedDashboardLogo = null;
  }
  return cachedDashboardLogo;
}

const FULL_LOGO_PATH = "images/faceclaw-logo.png";
let fullLogoSource: GrayImage | null | undefined;
const scaledFullLogos = new Map<number, GrayImage>();

/**
 * The full Faceclaw logo (the lobster over the smiley face), white on black,
 * scaled to `height` pixels tall for splash screens. The source is the phone
 * UI's black-on-transparent PNG, inverted, and area-averaged down so the
 * edges stay antialiased.
 */
export function getFullLogo(height: number): GrayImage | null {
  const targetHeight = Math.max(1, Math.round(height));
  const cached = scaledFullLogos.get(targetHeight);
  if (cached) return cached;
  if (fullLogoSource === undefined) {
    try {
      fullLogoSource = loadPngAsGrayImage(FULL_LOGO_PATH, { invert: true });
    } catch (error) {
      console.warn(`Could not load ${FULL_LOGO_PATH}: ${error}`);
      fullLogoSource = null;
    }
  }
  if (!fullLogoSource) return null;
  const scale = Math.min(1, targetHeight / fullLogoSource.height);
  const scaled = downscaleArea(
    fullLogoSource,
    Math.max(1, Math.round(fullLogoSource.width * scale)),
    Math.max(1, Math.round(fullLogoSource.height * scale)),
  );
  scaledFullLogos.set(targetHeight, scaled);
  return scaled;
}

/** Box-filter downscale: each output pixel averages the source pixels it covers. */
function downscaleArea(source: GrayImage, width: number, height: number): GrayImage {
  if (width === source.width && height === source.height) return source;
  const output = new GrayImage(width, height, 0);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * source.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * source.height) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * source.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * source.width) / width));
      let sum = 0;
      for (let sy = y0; sy < y1; sy++) {
        const row = sy * source.width;
        for (let sx = x0; sx < x1; sx++) sum += source.pixels[row + sx]!;
      }
      output.pixels[y * width + x] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
    }
  }
  return output;
}
