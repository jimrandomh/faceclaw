import { GrayImage } from './image'
import type { Plane } from './plane'

/** Crop one independently owned, opaque shell surface; never split it into tiles. */
export function shellCrop(image: GrayImage, x: number, y: number, width: number, height: number, key: number): Plane {
  const baked = image.withDrawsBaked(), crop = new GrayImage(width, height, 0)
  for (let row = 0; row < height; row++) crop.pixels.set(baked.pixels.subarray((y + row) * image.width + x, (y + row) * image.width + x + width), row * width)
  return { image: crop, x, y, shellKey: key }
}

/** Shared Kotlin receives original 8-bit pixels and quantizes once, before composing. */
export function encodeShellScene(planes: readonly Plane[]): Uint8Array {
  const layers: { image: GrayImage; x: number; y: number; key: number; dim: number }[] = []
  for (const plane of planes) {
    const image = plane.image.withDrawsBaked()
    let left = image.width, top = image.height, right = -1, bottom = -1
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      if (image.pixels[y * image.width + x] === 0) continue
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y)
    }
    if (right < left) continue
    const w = right - left + 1, h = bottom - top + 1
    if (5 + Math.ceil(w / 2) * h > 65536) throw new Error(`Shell surface ${plane.shellKey} exceeds 64 KiB (${w}×${h})`)
    const cropped = shellCrop(image, left, top, w, h, plane.shellKey!)
    layers.push({ image: cropped.image, x: plane.x + left, y: plane.y + top, key: plane.shellKey!, dim: Math.round((plane.dimUnderneath ?? 1) * 256) })
  }
  const result = new Uint8Array(2 + layers.reduce((n, l) => n + 14 + l.image.pixels.length, 0))
  const view = new DataView(result.buffer); let p = 0
  const word = (n: number) => { view.setUint16(p, n, true); p += 2 }
  word(layers.length)
  for (const l of layers) { word(l.key); word(l.x); word(l.y); word(l.image.width); word(l.image.height); word(l.dim); word(0); result.set(l.image.pixels, p); p += l.image.pixels.length }
  return result
}
