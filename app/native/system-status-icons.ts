import { Utils } from "@nativescript/core";

import { GrayImage } from "../graphics/image";

declare const com: any;

const ICON_SIZE = 24;
const ICON_CACHE_MS = 5_000;

let cachedIcons: GrayImage[] = [];
let cachedAtMs = 0;

export function readSystemStatusIcons(): GrayImage[] {
  if (!global.isAndroid) return [];

  const now = Date.now();
  if (now - cachedAtMs < ICON_CACHE_MS) {
    return cachedIcons.map(cloneGrayImage);
  }

  const context = Utils.android.getApplicationContext();
  if (!context) return [];

  const bytes = toUint8Array(
    com.faceclaw.app.FaceclawSystemStatusIconProvider.getSystemStatusIconGrays(context, ICON_SIZE),
  );
  const iconByteLength = ICON_SIZE * ICON_SIZE;
  const iconCount = Math.floor(bytes.length / iconByteLength);
  const icons: GrayImage[] = [];
  for (let index = 0; index < iconCount; index++) {
    const icon = new GrayImage(ICON_SIZE, ICON_SIZE, 0);
    icon.pixels.set(bytes.subarray(index * iconByteLength, (index + 1) * iconByteLength));
    icons.push(icon);
  }

  cachedIcons = icons;
  cachedAtMs = now;
  return icons.map(cloneGrayImage);
}

function toUint8Array(bytes: ArrayLike<number> | null | undefined): Uint8Array {
  if (!bytes) return new Uint8Array(0);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = bytes[i]! & 0xff;
  }
  return out;
}

function cloneGrayImage(image: GrayImage): GrayImage {
  const clone = new GrayImage(image.width, image.height, 0);
  clone.pixels.set(image.pixels);
  return clone;
}
