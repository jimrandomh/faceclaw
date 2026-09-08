import { concat, rle4 } from './ble-protocol'

/** Android BleImageOptimizer's mode-3 changed rectangle. Coordinates are in
 * units of 4 columns / 2 rows; pixels are top-down packed 4bpp, high nibble first.
 * null means identical, incomparable, or a full-screen box: use dedup/mode 6.
 */
export function buildBoundingBoxPayload(previous: Uint8Array | null, next: Uint8Array,
  width: number, height: number, frameId: number, deflate: (data: Uint8Array) => Uint8Array): Uint8Array | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
    width % 4 || height % 2 || width / 4 > 255 || height / 2 > 255 ||
    !previous || previous.length !== width * height / 2 || next.length !== previous.length) return null
  const stride = width / 2
  let minX = stride, maxX = -1, minY = height, maxY = -1
  for (let y = 0; y < height; y++) {
    const row = y * stride
    for (let x = 0; x < stride; x++) {
      if (previous[row + x] === next[row + x]) continue
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = y
    }
  }
  if (maxY < 0) return null
  const left = (minX * 2) & ~3, right = Math.min(width, ((maxX + 1) * 2 + 3) & ~3)
  const top = minY & ~1, bottom = Math.min(height, (maxY + 2) & ~1)
  const boxWidth = right - left, boxHeight = bottom - top
  if (boxWidth === width && boxHeight === height) return null
  const regionStride = boxWidth / 2, region = new Uint8Array(regionStride * boxHeight)
  for (let y = 0; y < boxHeight; y++) {
    const start = (top + y) * stride + left / 2
    region.set(next.subarray(start, start + regionStride), y * regionStride)
  }
  return concat(new Uint8Array([3, left / 4, top / 2, boxWidth / 4, boxHeight / 2,
    frameId & 255, (frameId >>> 8) & 255]), deflate(rle4(region)))
}
