import { ImageSource } from '@nativescript/core'
import { GrayImage } from '../graphics/image'

declare const FaceclawGraphics: any

type CropRect = { x: number; y: number; width: number; height: number }

/** The gray pixels of a screen area; black where it runs past the frame's edges. */
function cropGray(pixels: Uint8Array, width: number, height: number, crop: CropRect): Uint8Array {
  const cropped = new Uint8Array(crop.width * crop.height)
  const left = Math.max(crop.x, 0), right = Math.min(crop.x + crop.width, width)
  if (right <= left) return cropped
  for (let y = Math.max(crop.y, 0); y < Math.min(crop.y + crop.height, height); y++) {
    cropped.set(pixels.subarray(y * width + left, y * width + right), (y - crop.y) * crop.width + (left - crop.x))
  }
  return cropped
}

/** Gray pixels as the phone mirror's image, optionally cropped to a screen area (Preview scaling). */
export function previewPixels(pixels: Uint8Array, width: number, height: number, green = false, crop: CropRect | null = null): ImageSource {
  // NSData copies the buffer; the UIImage owns its pixels after this call.
  const copy = crop ? cropGray(pixels, width, height, crop) : new Uint8Array(pixels)
  const data = NSData.dataWithBytesLength(interop.handleof(copy.buffer), copy.byteLength)
  const native = FaceclawGraphics.previewWidthHeightGreen(data, crop?.width ?? width, crop?.height ?? height, green)
  if (!native) throw new Error('Could not create preview image')
  return new ImageSource(native)
}

/** Gray pixels as a white-on-transparent image (gray becomes alpha). */
export function whiteIconPixels(pixels: Uint8Array, width: number, height: number): ImageSource {
  const copy = new Uint8Array(pixels)
  const data = NSData.dataWithBytesLength(interop.handleof(copy.buffer), copy.byteLength)
  const native = FaceclawGraphics.whiteIconWidthHeight(data, width, height)
  if (!native) throw new Error('Could not create icon image')
  return new ImageSource(native)
}

export function rasterizeSvg(svg: string, size: number): GrayImage | null {
  const data = FaceclawGraphics.renderSVGSize(svg, size)
  if (!data) return null
  const image = new GrayImage(size, size, 0)
  image.pixels.set(new Uint8Array(interop.bufferFromData(data)))
  return image
}
