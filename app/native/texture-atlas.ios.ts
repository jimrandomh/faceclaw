import { toData } from './kotlin-data'
declare const FaceclawKitIosTextureAtlas: any
const atlas = FaceclawKitIosTextureAtlas.new()

export function textureAtlasAvailable(): boolean { return true }
export function textureFontId(key: string): number { return atlas.fontIdKey(key) }
export function registerTextureGlyphs(buffer: ArrayBuffer, aa: boolean): void {
  const data = toData(new Uint8Array(buffer))
  if (aa) atlas.registerAaGlyphsData(data)
  else atlas.registerGlyphsData(data)
}
export function registerFirmwareGlyphs(buffer: ArrayBuffer): void {
  atlas.registerFirmwareGlyphsData(toData(new Uint8Array(buffer)))
}
export function textureImageId(key: string, width: number, height: number, pixels: Uint8Array): number {
  return atlas.imageIdKeyWidthHeightData(key, width, height, toData(pixels))
}
