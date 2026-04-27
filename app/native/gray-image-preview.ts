import { ImageSource, Screen, Utils } from "@nativescript/core";

import { type GrayImage } from "../graphics/image";

const PREVIEW_BRIGHTEN_GAMMA = 0.7;

export function grayImageToPreviewSource(image: GrayImage): ImageSource | null {
  if (!global.isAndroid) {
    return null;
  }

  const colors = Array.create("int", image.width * image.height) as number[];
  for (let i = 0; i < image.pixels.length; i++) {
    const gray = brightenForPreview(image.pixels[i] ?? 0);
    colors[i] = (255 << 24) | (gray << 16) | (gray << 8) | gray;
  }

  const bitmap = android.graphics.Bitmap.createBitmap(
    colors,
    image.width,
    image.height,
    android.graphics.Bitmap.Config.ARGB_8888,
  );
  const targetWidth = Math.max(1, Math.round(Utils.layout.toDevicePixels(Screen.mainScreen.widthDIPs)));
  const targetHeight = Math.max(1, Math.round((targetWidth * image.height) / image.width));
  const scaledBitmap =
    bitmap.getWidth() === targetWidth && bitmap.getHeight() === targetHeight
      ? bitmap
      : android.graphics.Bitmap.createScaledBitmap(bitmap, targetWidth, targetHeight, false);
  return new ImageSource(scaledBitmap);
}

function brightenForPreview(gray: number): number {
  const normalized = Math.max(0, Math.min(255, gray)) / 255;
  return Math.max(0, Math.min(255, Math.round(255 * Math.pow(normalized, PREVIEW_BRIGHTEN_GAMMA))));
}
