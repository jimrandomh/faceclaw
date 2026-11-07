import { textureFontIdFor, textureImageIdFor } from "../web/texture-ids";

/** See texture-atlas.web.ts: the atlas lives on the main thread, and these messages reach it in order. */
const announcedFonts = new Set<string>();
const announcedImages = new Set<string>();

export function textureAtlasAvailable(): boolean { return true; }

export function textureFontId(key: string): number {
  const id = textureFontIdFor(key);
  if (!announcedFonts.has(key)) {
    announcedFonts.add(key);
    global.postMessage({ type: "__atlas-font", key, id });
  }
  return id;
}

export function registerTextureGlyphs(buffer: ArrayBuffer, aa: boolean): void {
  global.postMessage({ type: "__atlas-glyphs", buffer, aa });
}

export function registerFirmwareGlyphs(buffer: ArrayBuffer): void {
  global.postMessage({ type: "__atlas-firmware", buffer });
}

export function textureImageId(key: string, width: number, height: number, pixels: Uint8Array): number {
  const id = textureImageIdFor(key);
  if (!announcedImages.has(key)) {
    announcedImages.add(key);
    global.postMessage({ type: "__atlas-image", key, id, width, height, pixels: pixels.slice() });
  }
  return id;
}
