/**
 * Image decoding for the browser. Native builds decode synchronously, and so must
 * this: createImageBitmap is asynchronous, so PNG (through upng-js) is what the
 * demo can show, which covers its sample files and generated album art.
 */
import { File } from "@nativescript/core";
import { GrayImage } from "../graphics/image";
import { toUint8Array } from "../util/array-util";

const UPNG = require("upng-js");

const DECODABLE_IMAGE = /\.png$/i;

export function isDecodableImageFile(name: string): boolean {
  return DECODABLE_IMAGE.test(name);
}

export type GrayImageTone = { gamma?: number; dither?: boolean };

export const PHOTO_GAMMA = 2.2;
export const PHOTO_TONE: Readonly<Required<GrayImageTone>> = { gamma: PHOTO_GAMMA, dither: true };

export function resolveGrayImageTone(tone?: GrayImageTone): { gamma: number; dither: boolean } {
  return { gamma: tone?.gamma ?? 1, dither: tone?.dither ?? false };
}

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

/** RGBA to gray with GrayPacket's tone curve (out = in^gamma, premultiplied by alpha). */
export function grayFromRgba(rgba: Uint8Array, width: number, height: number, tone?: GrayImageTone): GrayImage {
  const { gamma, dither } = resolveGrayImageTone(tone);
  const image = new GrayImage(width, height, 0);
  const levels = new Float32Array(width * height);
  for (let i = 0; i < levels.length; i++) {
    const luminance = (0.2126 * rgba[i * 4]! + 0.7152 * rgba[i * 4 + 1]! + 0.0722 * rgba[i * 4 + 2]!) / 255;
    levels[i] = 255 * Math.pow(luminance, gamma) * (rgba[i * 4 + 3]! / 255);
  }
  if (!dither) {
    for (let i = 0; i < levels.length; i++) image.pixels[i] = Math.round(levels[i]!);
    return image;
  }
  // Floyd-Steinberg onto the display's 16 levels.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      const value = Math.max(0, Math.min(255, levels[at]!));
      const quantized = Math.round(value / 17) * 17;
      image.pixels[at] = quantized;
      const error = value - quantized;
      if (x + 1 < width) levels[at + 1]! += (error * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) levels[at + width - 1]! += (error * 3) / 16;
        levels[at + width]! += (error * 5) / 16;
        if (x + 1 < width) levels[at + width + 1]! += error / 16;
      }
    }
  }
  return image;
}

function scaled(source: GrayImage, maxWidth: number, maxHeight: number): GrayImage {
  const ratio = Math.min(1, maxWidth / source.width, maxHeight / source.height);
  if (ratio >= 1) return source;
  const width = Math.max(1, Math.round(source.width * ratio)), height = Math.max(1, Math.round(source.height * ratio));
  const image = new GrayImage(width, height, 0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      image.pixels[y * width + x] = source.pixels[Math.floor(y / ratio) * source.width + Math.floor(x / ratio)]!;
    }
  }
  return image;
}

export function decodePngToGray(bytes: Uint8Array, maxWidth: number, maxHeight: number, tone?: GrayImageTone): GrayImage | null {
  try {
    const decoded = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const frames = UPNG.toRGBA8(decoded) as ArrayBuffer[];
    if (!frames.length) return null;
    return scaled(grayFromRgba(new Uint8Array(frames[0]!), decoded.width, decoded.height, tone), maxWidth, maxHeight);
  } catch (error) {
    console.warn(`Could not decode an image: ${error}`);
    return null;
  }
}

export function loadImageFileAsGray(path: string, maxWidth: number, maxHeight: number, tone?: GrayImageTone): GrayImage | null {
  if (!File.exists(path) || !isDecodableImageFile(path)) return null;
  return decodePngToGray(File.fromPath(path).readSync(), maxWidth, maxHeight, tone);
}
