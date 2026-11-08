import { toUint8Array } from '../util/array-util'
import { copyToJavaByteBuffer } from './java-direct-buffer'
declare const com: any

/** Decoded RGBA (not premultiplied) of encoded image bytes, or null when undecodable. */
export function decodeImageRgba(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } | null {
  try {
    return rgbaFromPacket(toUint8Array(com.faceclaw.app.ImageFileLoader.decodeRgbaFromBytes(copyToJavaByteBuffer(bytes))))
  } catch (error) {
    console.warn(`decodeImageRgba failed: ${error}`)
    return null
  }
}

/** [widthLo, widthHi, heightLo, heightHi, RGBA...] as an image, or null when short. */
export function rgbaFromPacket(packet: Uint8Array): { width: number; height: number; rgba: Uint8Array } | null {
  if (packet.length < 4) return null
  const width = packet[0]! | (packet[1]! << 8)
  const height = packet[2]! | (packet[3]! << 8)
  if (width <= 0 || height <= 0 || packet.length < 4 + width * height * 4) return null
  return { width, height, rgba: packet.slice(4, 4 + width * height * 4) }
}
