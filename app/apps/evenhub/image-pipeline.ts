/**
 * updateImageRawData the way stock turns an app's imageData into the 4-bit
 * bitmap the glasses show. The Even phone app does the conversion
 * (EvenHubAppService.updateImageRawData → _prepare / _prepareLegacyRaw, read
 * from its blutter decompilation); the glasses firmware then shows the result
 * only if it is exactly the container's size (common_image_container_set_data).
 *
 * - imageData must be a JSON array of integers; a base64 string or an object
 *   (a typed array that skipped the SDK's toJson) fails as sendFailed.
 * - PNG, JPEG, WebP, GIF and BMP are decoded, scaled to cover the container
 *   (aspect-fill, centre crop, nearest neighbour) and converted to grey with
 *   alpha ignored.
 * - Anything else is raw pixels, accepted only with compressMode 2 (which the
 *   SDK sends since 0.0.12) and exactly the container's size: one byte per
 *   pixel (values up to 15 are already 4-bit levels) or 4-bit packed rows.
 *
 * Native-free so it runs under Node; JPEG/WebP/GIF decoding is injected.
 */
const UPNG = require("upng-js");

/** EhImageUpdateResult, as the SDK reads the host's integer. */
export const IMAGE_SUCCESS = 0;
export const IMAGE_EXCEPTION = 1;
export const IMAGE_SIZE_INVALID = 2;
export const IMAGE_TO_GRAY4_FAILED = 3;
export const IMAGE_SEND_FAILED = 4;

/** Stock image containers are 20..288 wide and 20..144 high. */
export const STOCK_IMAGE_MIN_SIZE = 20;
export const STOCK_IMAGE_MAX_WIDTH = 288;
export const STOCK_IMAGE_MAX_HEIGHT = 144;

/** The compressMode the SDK sends, and the phone app requires for raw pixels. */
const RAW_COMPRESS_MODE = 2;

export function inStockImageRange(width: number, height: number): boolean {
  return width >= STOCK_IMAGE_MIN_SIZE && width <= STOCK_IMAGE_MAX_WIDTH &&
    height >= STOCK_IMAGE_MIN_SIZE && height <= STOCK_IMAGE_MAX_HEIGHT;
}

export type ImageFormat = "png" | "jpeg" | "webp" | "gif" | "bmp" | "raw";

/** Format by magic bytes, as the phone app's EvenHubImageFormatDetector. */
export function detectImageFormat(b: Uint8Array): ImageFormat {
  const at = (i: number, ...values: number[]) => values.every((v, j) => b[i + j] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpeg";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  if (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61)) return "gif";
  if (at(0, 0x42, 0x4d)) return "bmp";
  return "raw";
}

/** Decoded pixels, RGBA, not premultiplied. */
export type RgbaImage = { width: number; height: number; rgba: Uint8Array };

export type NativeImageDecoder = (bytes: Uint8Array) => RgbaImage | null;

/** 8-bit grey from RGB (alpha ignored), then the nearest of 16 levels. */
export function grayLevel(r: number, g: number, b: number): number {
  const g8 = Math.floor((299 * r + 587 * g + 114 * b + 500) / 1000);
  return Math.min(15, Math.max(0, Math.floor((g8 * 15 + 127) / 255)));
}

export function rgbaToLevels(image: RgbaImage): Uint8Array {
  const levels = new Uint8Array(image.width * image.height);
  for (let i = 0; i < levels.length; i++) {
    const o = i * 4;
    levels[i] = grayLevel(image.rgba[o]!, image.rgba[o + 1]!, image.rgba[o + 2]!);
  }
  return levels;
}

/**
 * Scale to exactly width x height covering it (aspect-fill), cropping the
 * overflow equally on both sides, sampling the nearest source pixel centre.
 */
export function resizeRgbaCover(image: RgbaImage, width: number, height: number): RgbaImage {
  const scale = Math.max(width / image.width, height / image.height);
  const offX = (image.width - width / scale) / 2;
  const offY = (image.height - height / scale) / 2;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(image.height - 1, Math.max(0, Math.floor(offY + (y + 0.5) / scale)));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.max(0, Math.floor(offX + (x + 0.5) / scale)));
      const from = (sy * image.width + sx) * 4;
      rgba.set(image.rgba.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
}

function decodePng(bytes: Uint8Array): RgbaImage | null {
  try {
    const decoded = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const frames = UPNG.toRGBA8(decoded) as ArrayBuffer[];
    if (!frames.length) return null;
    return { width: decoded.width, height: decoded.height, rgba: new Uint8Array(frames[0]!) };
  } catch {
    return null;
  }
}

/**
 * Uncompressed Windows BMP ('BM', BI_RGB): 1/4/8-bit paletted and 24/32-bit,
 * top-down or bottom-up. Null for other variants (the native decoder may still
 * read them). EvenChess sends 1-bit BMPs for full-board refreshes.
 */
export function decodeBmp(bytes: Uint8Array): RgbaImage | null {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null;
  const u16 = (o: number) => bytes[o]! | (bytes[o + 1]! << 8);
  const u32 = (o: number) => (bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16) | (bytes[o + 3]! << 24)) >>> 0;
  const i32 = (o: number) => bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16) | (bytes[o + 3]! << 24);
  const pixelOffset = u32(10);
  const dibSize = u32(14);
  const width = i32(18);
  const heightRaw = i32(22);
  const bitCount = u16(28);
  if (u32(30) !== 0) return null; // only BI_RGB
  if (width <= 0 || width > 4096) return null;
  const topDown = heightRaw < 0;
  const height = Math.abs(heightRaw);
  if (height === 0 || height > 4096) return null;
  if (![1, 4, 8, 24, 32].includes(bitCount)) return null;

  // Palette entries are 4 bytes, BGRx.
  let palette: Uint8Array | null = null;
  if (bitCount <= 8) {
    let count = u32(46);
    if (count === 0 || count > 1 << bitCount) count = 1 << bitCount;
    palette = new Uint8Array(count * 3);
    for (let i = 0; i < count; i++) {
      const o = 14 + dibSize + i * 4;
      if (o + 2 >= bytes.length) break;
      palette.set([bytes[o + 2]!, bytes[o + 1]!, bytes[o]!], i * 3);
    }
  }
  const stride = ((width * bitCount + 31) >> 5) << 2;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = pixelOffset + (topDown ? y : height - 1 - y) * stride;
    if (row >= bytes.length) break;
    for (let x = 0; x < width; x++) {
      let r: number, g: number, b: number;
      if (palette) {
        let index: number;
        if (bitCount === 1) index = ((bytes[row + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1;
        else if (bitCount === 4) index = (x & 1) === 0 ? (bytes[row + (x >> 1)] ?? 0) >> 4 : (bytes[row + (x >> 1)] ?? 0) & 0x0f;
        else index = bytes[row + x] ?? 0;
        if (index * 3 >= palette.length) index = 0;
        [r, g, b] = [palette[index * 3]!, palette[index * 3 + 1]!, palette[index * 3 + 2]!];
      } else {
        const o = row + x * (bitCount / 8);
        [r, g, b] = [bytes[o + 2] ?? 0, bytes[o + 1] ?? 0, bytes[o] ?? 0];
      }
      rgba.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
}

/** imageData as bytes: a JSON array of integers only (Uint8List.fromList keeps the low 8 bits). */
function imageDataBytes(raw: unknown): Uint8Array | null {
  if (raw === undefined || raw === null) return new Uint8Array(0);
  if (!Array.isArray(raw)) return null;
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const value: unknown = raw[i];
    if (typeof value !== "number" || !Number.isInteger(value)) return null;
    out[i] = value & 0xff;
  }
  return out;
}

export type PreparedImage = {
  result: number;
  /** 4-bit levels (0..15), row-major, when result is success. */
  levels: Uint8Array | null;
  width: number;
  height: number;
  format: ImageFormat | null;
  /** Why it failed, for the debug log. */
  reason: string;
};

export type ImageRequest = {
  imageData: unknown;
  compressMode: number;
  /** width/height sent with the update; when both are positive they replace the container's. */
  requestWidth: number;
  requestHeight: number;
  /** The image container's size, looked up by id or name; null when none matched. */
  geometry: { width: number; height: number } | null;
  decodeNative: NativeImageDecoder;
  /** Stock pages limit image sizes; Faceclaw's extended layouts don't. */
  stockLimits: boolean;
};

/** Convert an update's imageData to 4-bit levels the way the phone app does. */
export function prepareImageUpdate(request: ImageRequest): PreparedImage {
  const fail = (result: number, reason: string, format: ImageFormat | null = null): PreparedImage =>
    ({ result, levels: null, width: 0, height: 0, format, reason });
  const bytes = imageDataBytes(request.imageData);
  if (!bytes) return fail(IMAGE_SEND_FAILED, "imageData is not an array of integers");
  const inRange = (w: number, h: number) => (request.stockLimits ? inStockImageRange(w, h) : w > 0 && h > 0);
  const [width, height] = request.requestWidth > 0 && request.requestHeight > 0
    ? [request.requestWidth, request.requestHeight]
    : [request.geometry?.width ?? 0, request.geometry?.height ?? 0];

  const format = detectImageFormat(bytes);
  if (format === "raw") {
    if (request.stockLimits && request.compressMode !== RAW_COMPRESS_MODE) {
      return fail(IMAGE_EXCEPTION, `raw pixels need compressMode ${RAW_COMPRESS_MODE}`, format);
    }
    if (!inRange(width, height)) return fail(IMAGE_SIZE_INVALID, `raw size ${width}x${height} out of range`, format);
    const levels = new Uint8Array(width * height);
    const packedStride = Math.ceil(width / 2);
    if (bytes.length === width * height) {
      for (let i = 0; i < levels.length; i++) {
        const v = bytes[i]!;
        levels[i] = v <= 15 ? v : Math.floor((v * 15 + 127) / 255);
      }
    } else if (bytes.length === packedStride * height) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const byte = bytes[y * packedStride + (x >> 1)]!;
          levels[y * width + x] = (x & 1) === 0 ? byte >> 4 : byte & 0x0f;
        }
      }
    } else {
      return fail(IMAGE_EXCEPTION, `raw length ${bytes.length} fits neither ${width}x${height} 8-bit nor 4-bit`, format);
    }
    return { result: IMAGE_SUCCESS, levels, width, height, format, reason: "" };
  }

  let decoded = format === "png" ? decodePng(bytes) : format === "bmp" ? decodeBmp(bytes) : null;
  decoded ??= request.decodeNative(bytes);
  if (!decoded || decoded.width <= 0 || decoded.height <= 0) return fail(IMAGE_EXCEPTION, `${format} decode failed`, format);
  if (inRange(width, height) && (decoded.width !== width || decoded.height !== height)) {
    decoded = resizeRgbaCover(decoded, width, height);
  }
  if (!inRange(decoded.width, decoded.height)) {
    return fail(IMAGE_SIZE_INVALID, `${decoded.width}x${decoded.height} out of range`, format);
  }
  return { result: IMAGE_SUCCESS, levels: rgbaToLevels(decoded), width: decoded.width, height: decoded.height, format, reason: "" };
}
