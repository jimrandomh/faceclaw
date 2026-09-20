/**
 * Image-file decoding for the on-glasses image viewer, backed by the Java
 * ImageFileLoader (BitmapFactory handles PNG/JPEG/GIF/BMP/WebP/HEIC).
 */
import { GrayImage } from "../graphics/image";
import { toUint8Array } from "../util/array-util";

declare const com: any;
declare const global: any;

/** File extensions BitmapFactory can decode (no SVG). */
const DECODABLE_IMAGE = /\.(png|jpe?g|gif|bmp|webp|heic|heif)$/i;

export function isDecodableImageFile(name: string): boolean {
  return DECODABLE_IMAGE.test(name);
}

/**
 * How source gray maps onto the display's 16 levels when converting to a
 * GrayImage. The default (gamma 1, no dither) is a flat conversion with
 * per-pixel rounding, right for UI raster such as icons and map tiles.
 */
export type GrayImageTone = {
  /**
   * Tone curve out = in^gamma (in 0..1). gamma > 1 darkens midtones: source
   * pixels are sRGB-encoded but the G2 drives its levels roughly linearly,
   * so untouched photos read washed out.
   */
  gamma?: number;
  /**
   * Floyd-Steinberg error diffusion onto the 16 display levels instead of
   * rounding each pixel independently, which bands smooth gradients.
   */
  dither?: boolean;
};

/**
 * Gamma for continuous-tone images (photos, album art): 2.2 undoes the sRGB
 * encoding outright. Lower it toward ~1.8 if shadows crush.
 */
export const PHOTO_GAMMA = 2.2;

/** Tone preset for continuous-tone images: sRGB gamma plus dithering. */
export const PHOTO_TONE: Readonly<Required<GrayImageTone>> = { gamma: PHOTO_GAMMA, dither: true };

/** Resolve a tone to the (gamma, dither) pair the Java helpers take. */
export function resolveGrayImageTone(tone?: GrayImageTone): { gamma: number; dither: boolean } {
  return { gamma: tone?.gamma ?? 1, dither: tone?.dither ?? false };
}

/**
 * Decode a gray packet ([widthLo, widthHi, heightLo, heightHi, pixels...],
 * the format the Java helpers return) into a GrayImage; null when empty or
 * malformed.
 */
export function grayImageFromPacket(raw: ArrayLike<number> | null | undefined): GrayImage | null {
  const bytes = toUint8Array(raw);
  if (bytes.length < 4) return null;
  const width = bytes[0]! | (bytes[1]! << 8);
  const height = bytes[2]! | (bytes[3]! << 8);
  if (width <= 0 || height <= 0 || bytes.length < 4 + width * height) return null;
  const image = new GrayImage(width, height, 0);
  image.pixels.set(bytes.subarray(4, 4 + width * height));
  return image;
}

/**
 * Load an image file as grayscale, downscaled to fit maxWidth x maxHeight
 * (aspect preserved, never upscaled); null when unreadable or undecodable.
 * Pass PHOTO_TONE for continuous-tone images; the default is a flat
 * conversion for UI raster.
 */
export function loadImageFileAsGray(
  path: string,
  maxWidth: number,
  maxHeight: number,
  tone?: GrayImageTone,
): GrayImage | null {
  if (!global.isAndroid) return null;
  try {
    const { gamma, dither } = resolveGrayImageTone(tone);
    return grayImageFromPacket(
      com.faceclaw.app.ImageFileLoader.loadGray(path, Math.round(maxWidth), Math.round(maxHeight), gamma, dither),
    );
  } catch (error) {
    console.warn(`loadImageFileAsGray failed for ${path}: ${error}`);
    return null;
  }
}
