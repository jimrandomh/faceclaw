import { ImageSource } from "@nativescript/core";

import { type GrayImage } from "../graphics/image";
import { copyToJavaByteBuffer } from "./java-direct-buffer";

declare const com: any;

const PREVIEW_BRIGHTEN_GAMMA = 0.7;

/**
 * Build the phone-UI preview for a frame. The pixels are copied into a Java
 * direct ByteBuffer and expanded to ARGB there; doing the per-pixel work in JS
 * or copying element-by-element across the bridge costs ~150ms per frame, and
 * passing the ArrayBuffer itself would leak it (java-direct-buffer.ts).
 */
export function grayImageToPreviewSource(image: GrayImage): ImageSource | null {
  if (!global.isAndroid) {
    return null;
  }

  const baked = image.withDrawsBaked();
  const bitmap = com.faceclaw.app.PreviewBitmapUtil.fromGray(
    copyToJavaByteBuffer(baked.pixels),
    baked.width,
    baked.height,
    PREVIEW_BRIGHTEN_GAMMA,
  );
  return new ImageSource(bitmap);
}
