import { fromData, toData } from '../native/kotlin-data'
import type { SurfaceConfiguration, SurfaceRect } from './surface-compositor'
export type { SurfaceConfiguration, SurfaceRect } from './surface-compositor'
declare const FaceclawKitIosSurfaceCompositor: any
/** Retained pixels, clipping, layers and composition live in shared Kotlin. */
export class SurfaceCompositor {
  private native: any
  private readonly surfaces = new Set<string>()
  constructor(readonly width: number, readonly height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error('Invalid compositor size')
    this.native = FaceclawKitIosSurfaceCompositor.alloc().initWithWidthHeight(width, height)
  }
  configureSurface(id: string, options: SurfaceConfiguration): void {
    if (![options.x, options.y, options.width, options.height, options.zOrder].every(Number.isInteger)
      || options.width <= 0 || options.height <= 0) throw new Error('Invalid surface geometry')
    this.native.configureIdXYWidthHeightZOrderTransparent(id, options.x, options.y, options.width, options.height, options.zOrder, options.transparency === 'color-key')
    this.surfaces.add(id)
  }
  removeSurface(id: string): void { this.native.removeId(id); this.surfaces.delete(id) }
  setSurfaceVisible(id: string, visible: boolean): void { this.native.visibleIdVisible(id, visible) }
  setUnderlayDim(belowZOrder: number, factor: number): void {
    if (!Number.isFinite(factor)) throw new Error('Invalid dim factor')
    this.native.dimBelowFactor(belowZOrder, factor)
  }
  setScreenBlanked(blanked: boolean): void { this.native.blankBlanked(blanked) }
  submitSurfaceFrame(id: string, pixels: Uint8Array, rect: SurfaceRect): void {
    // Keep lifecycle errors catchable in JS; an undeclared Kotlin exception
    // crossing the Objective-C boundary terminates the process.
    if (!this.surfaces.has(id)) throw new Error(`Unknown surface: ${id}`)
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger)
      || rect.width <= 0 || rect.height <= 0 || pixels.length !== rect.width * rect.height) throw new Error('Invalid frame buffer or rectangle')
    this.native.submitIdDataXYWidthHeight(id, toData(pixels), rect.x, rect.y, rect.width, rect.height)
  }
  composite(): Uint8Array { return fromData(this.native.composite()) }
}
