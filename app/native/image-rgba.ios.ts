import { toData, fromData } from './kotlin-data'
import { rgbaFromPacket } from './image-rgba'
declare const FaceclawGraphics: any

/** Decoded RGBA of encoded image bytes, or null when undecodable (transparent pixels come out black). */
export function decodeImageRgba(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } | null {
  const data = FaceclawGraphics.rgbaPacketFromImageData(toData(bytes))
  return data ? rgbaFromPacket(fromData(data)) : null
}
