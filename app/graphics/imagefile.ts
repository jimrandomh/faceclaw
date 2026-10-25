import { File, knownFolders } from "@nativescript/core";

import { GrayImage } from "./image";

declare const interop: any;

const UPNG = require("upng-js");

/**
 * Decode a PNG to grayscale, premultiplied by alpha so transparency reads as
 * black. With `invert`, the PNG is dark art on a light or transparent ground
 * (e.g. the phone-side logo) and its ink is drawn white instead.
 */
export function loadPngAsGrayImage(path: string, options: { invert?: boolean } = {}): GrayImage {
  const file = resolveFile(path);
  const raw = file.readSync();
  const pngBuffer = toArrayBuffer(raw);
  const decoded = UPNG.decode(pngBuffer);
  const frames = UPNG.toRGBA8(decoded) as ArrayBuffer[];
  if (!frames.length) {
    throw new Error(`PNG contains no frames: ${path}`);
  }

  const rgba = new Uint8Array(frames[0]!);
  const image = new GrayImage(decoded.width, decoded.height, 0);
  for (let y = 0; y < decoded.height; y++) {
    for (let x = 0; x < decoded.width; x++) {
      const offset = (y * decoded.width + x) * 4;
      const r = rgba[offset] ?? 0;
      const g = rgba[offset + 1] ?? 0;
      const b = rgba[offset + 2] ?? 0;
      const a = (rgba[offset + 3] ?? 0) / 255;
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const gray = Math.round((options.invert ? 255 - luminance : luminance) * a);
      image.pixels[y * decoded.width + x] = gray;
    }
  }
  return image;
}

function resolveFile(path: string): File {
  if (!path) {
    throw new Error("PNG path is required");
  }
  return path.startsWith("/") ? File.fromPath(path) : knownFolders.currentApp().getFile(path);
}

function toArrayBuffer(raw: unknown): ArrayBuffer {
  if (raw instanceof ArrayBuffer) {
    return raw.slice(0);
  }
  if (raw instanceof Uint8Array) {
    return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  }
  if (global.isAndroid && raw && typeof (raw as { length?: unknown }).length === "number") {
    const bytes = raw as ArrayLike<number>;
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      out[i] = bytes[i]! & 0xff;
    }
    return out.buffer;
  }
  if (global.isIOS && raw) {
    return interop.bufferFromData(raw);
  }
  throw new Error(`Unsupported PNG byte source: ${String(raw)}`);
}
