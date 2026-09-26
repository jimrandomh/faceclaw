import { GrayImage } from '../graphics/image'
import { toData, fromData } from './kotlin-data'
declare const FaceclawGraphics: any

/** Native image decoding and grayscale conversion, safe on a rendering worker. */
export function decodeImageBytes(bytes: ArrayBuffer, width: number, height: number): GrayImage | null {
  const data = FaceclawGraphics.decodeImageWidthHeight(toData(new Uint8Array(bytes)), width, height)
  if (!data) return null
  const image = new GrayImage(width, height, 0)
  image.pixels.set(fromData(data))
  return image
}
