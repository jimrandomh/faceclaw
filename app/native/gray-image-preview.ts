import { ImageSource } from "@nativescript/core";

import { type GrayImage } from "../graphics/image";

const PREVIEW_BRIGHTEN_GAMMA = 0.7;
const PREVIEW_COLOR_LUT = buildPreviewColorLookup();

export function grayImageToPreviewSource(image: GrayImage): ImageSource | null {
  if (!global.isAndroid) {
    return null;
  }

  const colors = Array.create("int", image.width * image.height) as number[];
  for (let i = 0; i < image.pixels.length; i++) {
    colors[i] = PREVIEW_COLOR_LUT[image.pixels[i] ?? 0]!;
  }

  const bitmap = android.graphics.Bitmap.createBitmap(
    colors,
    image.width,
    image.height,
    android.graphics.Bitmap.Config.ARGB_8888,
  );
  return new ImageSource(bitmap);
}

function buildPreviewColorLookup(): number[] {
  const colors: number[] = [];
  for (let gray = 0; gray <= 255; gray++) {
    const normalized = gray / 255;
    const preview = Math.max(0, Math.min(255, Math.round(255 * Math.pow(normalized, PREVIEW_BRIGHTEN_GAMMA))));
    colors[gray] = (255 << 24) | (preview << 16) | (preview << 8) | preview;
  }
  return colors;
}
