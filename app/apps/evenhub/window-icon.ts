/**
 * App-supplied window icons (the extension setWindowIcon): parse the pixel
 * buffer an app sends and scale it to the sizes the app switcher draws at.
 * Pure, so it can be tested without NativeScript.
 */
import { GrayImage } from "../../graphics/image";

/** Larger icons are refused: they only cost bridge traffic, since switcher icons are ~32px. */
export const MAX_WINDOW_ICON_DIMENSION = 256;

/**
 * Parse `{width, height, data}` from the bridge into a grayscale image.
 * `data` is width*height brightness bytes, or width*height*4 RGBA bytes (an
 * ImageData), which are reduced to luminance times alpha. Arrays arrive as
 * plain arrays or as JSON-ified typed arrays ({"0": n, ...}). Returns null for
 * anything malformed.
 */
export function parseWindowIcon(raw: unknown): GrayImage | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const width = Number(record.width);
  const height = Number(record.height);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < 1 || height < 1 || width > MAX_WINDOW_ICON_DIMENSION || height > MAX_WINDOW_ICON_DIMENSION) return null;
  const data = toNumberArray(record.data);
  if (!data) return null;
  const area = width * height;
  const image = new GrayImage(width, height, 0);
  if (data.length === area) {
    for (let i = 0; i < area; i++) image.pixels[i] = clampByte(data[i]!);
  } else if (data.length === area * 4) {
    for (let i = 0; i < area; i++) {
      const o = i * 4;
      const luminance = 0.2126 * data[o]! + 0.7152 * data[o + 1]! + 0.0722 * data[o + 2]!;
      image.pixels[i] = clampByte((luminance * data[o + 3]!) / 255);
    }
  } else {
    return null;
  }
  return image;
}

/**
 * Scale an icon to fit a size x size box, keeping its aspect ratio, with an
 * area-averaging filter. Results are cached per size, since the switcher
 * repaints often.
 */
export class WindowIconRenderer {
  private readonly scaled = new Map<number, GrayImage>();

  constructor(private readonly source: GrayImage) {}

  render(size: number): GrayImage {
    const box = Math.max(1, Math.round(size));
    let image = this.scaled.get(box);
    if (!image) {
      image = scaleToFit(this.source, box);
      this.scaled.set(box, image);
    }
    return image;
  }
}

function scaleToFit(source: GrayImage, box: number): GrayImage {
  const scale = Math.min(box / source.width, box / source.height);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  if (width === source.width && height === source.height) return source;
  const out = new GrayImage(width, height, 0);
  for (let y = 0; y < height; y++) {
    const y0 = (y * source.height) / height;
    const y1 = ((y + 1) * source.height) / height;
    for (let x = 0; x < width; x++) {
      const x0 = (x * source.width) / width;
      const x1 = ((x + 1) * source.width) / width;
      out.pixels[y * width + x] = clampByte(areaAverage(source, x0, y0, x1, y1));
    }
  }
  return out;
}

/** Mean of the source over the rectangle [x0,x1) x [y0,y1), weighting partly covered pixels. */
function areaAverage(source: GrayImage, x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0;
  let weight = 0;
  for (let sy = Math.floor(y0); sy < Math.min(source.height, Math.ceil(y1)); sy++) {
    const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
    for (let sx = Math.floor(x0); sx < Math.min(source.width, Math.ceil(x1)); sx++) {
      const w = wy * (Math.min(x1, sx + 1) - Math.max(x0, sx));
      sum += source.pixels[sy * source.width + sx]! * w;
      weight += w;
    }
  }
  return weight > 0 ? sum / weight : 0;
}

function toNumberArray(raw: unknown): number[] | null {
  let values: unknown[];
  if (Array.isArray(raw)) {
    values = raw;
  } else if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    values = [];
    for (let i = 0; String(i) in record; i++) values.push(record[String(i)]);
  } else {
    return null;
  }
  const out: number[] = [];
  for (const entry of values) {
    const value = Number(entry);
    if (!Number.isFinite(value)) return null;
    out.push(value);
  }
  return out;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}
