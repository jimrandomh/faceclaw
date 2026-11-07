import { WebTextureAtlas } from "faceclaw-kit";
import { textureFontIdFor, textureImageIdFor } from "../web/texture-ids";

/**
 * The main thread's atlas: the one the compositor and display-list renderer
 * read. Workers can't reach it to ask for ids, so every context derives them
 * from the key (texture-ids.ts) and workers forward their registrations
 * (texture-atlas.webworker.ts), in order with the frames that use them.
 */
const signed = (bytes: Uint8Array) => new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const assignedFonts = new Set<string>();

function ensureFont(key: string, id: number): void {
  if (assignedFonts.has(key)) return;
  assignedFonts.add(key);
  WebTextureAtlas.getInstance().assignFontId(key, id);
}

export function textureAtlasAvailable(): boolean { return true; }

export function textureFontId(key: string): number {
  const id = textureFontIdFor(key);
  ensureFont(key, id);
  return id;
}

export function registerTextureGlyphs(buffer: ArrayBuffer, aa: boolean): void {
  const bytes = signed(new Uint8Array(buffer));
  if (aa) WebTextureAtlas.getInstance().registerAaGlyphs(bytes);
  else WebTextureAtlas.getInstance().registerGlyphs(bytes);
}

export function registerFirmwareGlyphs(buffer: ArrayBuffer): void {
  WebTextureAtlas.getInstance().registerFirmwareGlyphs(signed(new Uint8Array(buffer)));
}

export function textureImageId(key: string, width: number, height: number, pixels: Uint8Array): number {
  const id = textureImageIdFor(key);
  WebTextureAtlas.getInstance().registerImage(key, id, width, height, signed(pixels));
  return id;
}

/** A worker's registration, delivered before any frame that refers to it. */
export function applyWorkerAtlasMessage(message: any): void {
  switch (message.type) {
    case "__atlas-font": ensureFont(message.key, message.id); break;
    case "__atlas-glyphs": registerTextureGlyphs(message.buffer, message.aa); break;
    case "__atlas-firmware": registerFirmwareGlyphs(message.buffer); break;
    case "__atlas-image":
      WebTextureAtlas.getInstance().registerImage(message.key, message.id, message.width, message.height, signed(message.pixels));
      break;
  }
}
