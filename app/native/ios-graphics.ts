import { ImageSource } from '@nativescript/core'
import { GrayImage } from '../graphics/image'

declare const FaceclawGraphics: any

export function previewPixels(pixels: Uint8Array, width: number, height: number, green = false): ImageSource {
  // NSData copies the buffer; the UIImage owns its pixels after this call.
  const copy = new Uint8Array(pixels)
  const data = NSData.dataWithBytesLength(interop.handleof(copy.buffer), copy.byteLength)
  const native = FaceclawGraphics.previewWidthHeightGreen(data, width, height, green)
  if (!native) throw new Error('Could not create preview image')
  return new ImageSource(native)
}

export function rasterizeSvg(svg: string, size: number): GrayImage | null {
  const data = FaceclawGraphics.renderSVGSize(svg, size)
  if (!data) return null
  const image = new GrayImage(size, size, 0)
  image.pixels.set(new Uint8Array(interop.bufferFromData(data)))
  return image
}
