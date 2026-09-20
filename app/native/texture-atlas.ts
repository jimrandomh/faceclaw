declare const com: any

/** Android bridge to the process-wide shared Kotlin atlases. */
export function textureAtlasAvailable(): boolean { return !!global.isAndroid }
export function textureFontId(key: string): number { return com.faceclaw.app.GlyphAtlas.fontId(key) }
export function registerTextureGlyphs(buffer: ArrayBuffer, aa: boolean): void {
  const reader = new com.faceclaw.app.AndroidByteReader(buffer)
  if (aa) com.faceclaw.app.GlyphAtlas.registerAa(reader)
  else com.faceclaw.app.GlyphAtlas.register(reader)
}
export function registerFirmwareGlyphs(buffer: ArrayBuffer): void {
  com.faceclaw.app.FwGlyphAtlas.register(new com.faceclaw.app.AndroidByteReader(buffer))
}
export function textureImageId(key: string, width: number, height: number, pixels: Uint8Array): number {
  const buffer = pixels.byteOffset === 0 && pixels.byteLength === pixels.buffer.byteLength ? pixels.buffer : pixels.slice().buffer
  return com.faceclaw.app.ImageAtlas.ensure(key, width, height, new com.faceclaw.app.AndroidByteReader(buffer))
}
