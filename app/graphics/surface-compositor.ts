/** Platform-independent 8bpp surface composition for the local display. */
export type SurfaceRect = { x: number; y: number; width: number; height: number }
export type SurfaceConfiguration = SurfaceRect & {
  zOrder: number
  transparency: 'opaque' | 'color-key'
}
type Surface = SurfaceConfiguration & { pixels: Uint8Array; visible: boolean }

export class SurfaceCompositor {
  private readonly surfaces = new Map<string, Surface>()
  private dimBelow = 0
  private dimFactor = 1
  private blanked = false
  constructor(readonly width: number, readonly height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error('Invalid compositor size')
    }
  }
  configureSurface(id: string, options: SurfaceConfiguration): void {
    if (![options.x, options.y, options.width, options.height, options.zOrder].every(Number.isInteger)
      || options.width <= 0 || options.height <= 0) throw new Error('Invalid surface geometry')
    const previous = this.surfaces.get(id)
    const pixels = previous?.width === options.width && previous.height === options.height
      ? previous.pixels : new Uint8Array(options.width * options.height)
    this.surfaces.set(id, { ...options, pixels, visible: previous?.visible ?? true })
  }
  removeSurface(id: string): void { this.surfaces.delete(id) }
  setSurfaceVisible(id: string, visible: boolean): void {
    const surface = this.surfaces.get(id)
    if (surface) surface.visible = visible
  }
  setUnderlayDim(belowZOrder: number, factor: number): void {
    if (!Number.isFinite(factor)) throw new Error('Invalid dim factor')
    this.dimBelow = belowZOrder
    this.dimFactor = Math.max(0, Math.min(1, factor))
  }
  setScreenBlanked(blanked: boolean): void { this.blanked = blanked }
  submitSurfaceFrame(id: string, pixels: Uint8Array, rect: SurfaceRect): void {
    const surface = this.surfaces.get(id)
    if (!surface) throw new Error(`Unknown surface: ${id}`)
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger)
      || rect.width <= 0 || rect.height <= 0 || pixels.length !== rect.width * rect.height) {
      throw new Error('Invalid frame buffer or rectangle')
    }
    const left = Math.max(0, rect.x), right = Math.min(surface.width, rect.x + rect.width)
    const top = Math.max(0, rect.y), bottom = Math.min(surface.height, rect.y + rect.height)
    for (let y = top; y < bottom; y++) {
      if (right <= left) break
      const source = (y - rect.y) * rect.width + left - rect.x
      surface.pixels.set(pixels.subarray(source, source + right - left), y * surface.width + left)
    }
  }
  composite(): Uint8Array {
    const output = new Uint8Array(this.width * this.height)
    if (this.blanked) return output
    const surfaces = [...this.surfaces.values()].filter(s => s.visible).sort((a, b) => a.zOrder - b.zOrder)
    for (const surface of surfaces) {
      const left = Math.max(0, surface.x), right = Math.min(this.width, surface.x + surface.width)
      const top = Math.max(0, surface.y), bottom = Math.min(this.height, surface.y + surface.height)
      const dim = surface.zOrder < this.dimBelow ? this.dimFactor : 1
      for (let y = top; y < bottom; y++) {
        let source = (y - surface.y) * surface.width + left - surface.x
        let target = y * this.width + left
        for (let x = left; x < right; x++, source++, target++) {
          const value = surface.pixels[source]
          // Test the original value: opaque near-black must still cover the
          // window beneath, even when dimming rounds it down to black.
          if (surface.transparency === 'color-key' && value === 0) continue
          output[target] = Math.round(value * dim)
        }
      }
    }
    return output
  }
}
