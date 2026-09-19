import { fromData, toData } from '../native/kotlin-data'
import type { SurfaceConfiguration, SurfaceRect } from './surface-compositor'
export type { SurfaceConfiguration, SurfaceRect } from './surface-compositor'
declare const FaceclawKitIosSurfaceCompositor: any
/** Retained pixels, clipping, layers and composition live in shared Kotlin. */
export class SurfaceCompositor {
  private native: any
  constructor(readonly width: number, readonly height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error('Invalid compositor size')
    this.native = FaceclawKitIosSurfaceCompositor.alloc().initWithWidthHeight(width, height)
  }
  configureSurface(id: string, options: SurfaceConfiguration): void {
    if (![options.x, options.y, options.width, options.height, options.zOrder].every(Number.isInteger)
      || options.width <= 0 || options.height <= 0) throw new Error('Invalid surface geometry')
    this.native.configureIdXYWidthHeightZOrderTransparent(id, options.x, options.y, options.width, options.height, options.zOrder, options.transparency === 'color-key')
  }
  removeSurface(id: string): void { this.native.removeId(id) }
  setSurfaceVisible(id: string, visible: boolean): void { this.native.visibleIdVisible(id, visible) }
  setUnderlayDim(belowZOrder: number, factor: number): void {
    if (!Number.isFinite(factor)) throw new Error('Invalid dim factor')
    this.native.dimBelowFactor(belowZOrder, factor)
  }
  setScreenBlanked(blanked: boolean): void { this.native.blankBlanked(blanked) }
  submitSurfaceFrame(id: string, pixels: Uint8Array, rect: SurfaceRect): void {
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger)
      || rect.width <= 0 || rect.height <= 0 || pixels.length !== rect.width * rect.height) throw new Error('Invalid frame buffer or rectangle')
    this.native.submitIdDataXYWidthHeight(id, toData(pixels), rect.x, rect.y, rect.width, rect.height)
  }
  composite(): Uint8Array { return fromData(this.native.composite()) }
}
