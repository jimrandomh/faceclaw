import { presentationRecords, readPresentation, paintPresentation, type Selection } from "./presentation-wire"
/** Platform-independent 8bpp surface composition for the local display. */
export type SurfaceRect = { x: number; y: number; width: number; height: number }
export type SurfaceConfiguration = SurfaceRect & {
  zOrder: number
  transparency: 'opaque' | 'color-key'
}
type Surface = SurfaceConfiguration & { pixels: Uint8Array; visible: boolean; selections: Selection[] }

export class SurfaceCompositor {
  private readonly surfaces = new Map<string, Surface>()
  private shellScene: Uint8Array | null = null
  private shellReceivedAt = 0
  setShellScene(bytes: Uint8Array): void { this.shellScene = new Uint8Array(bytes); this.shellReceivedAt = Date.now() }
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
    this.surfaces.set(id, { ...options, pixels, visible: previous?.visible ?? true, selections: previous?.selections ?? [] })
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
  submitSurfaceFrame(id: string, pixels: Uint8Array, rect: SurfaceRect, _draws: ArrayBuffer | null = null): void {
    const surface = this.surfaces.get(id)
    if (!surface) throw new Error(`Unknown surface: ${id}`)
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger)
      || rect.width <= 0 || rect.height <= 0 || pixels.length !== rect.width * rect.height) {
      throw new Error('Invalid frame buffer or rectangle')
    }
    surface.selections = presentationRecords(_draws)
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
    const surfaces = [...this.surfaces.values()].filter(s => s.visible && !(this.shellScene && s === this.surfaces.get('shell'))).sort((a, b) => a.zOrder - b.zOrder)
    for (const surface of surfaces) {
      const left = Math.max(0, surface.x), right = Math.min(this.width, surface.x + surface.width)
      const top = Math.max(0, surface.y), bottom = Math.min(this.height, surface.y + surface.height)
      const dim = !this.shellScene && surface.zOrder < this.dimBelow ? this.dimFactor : 1
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
    const screen = output.slice()
    if (!surfaces.some(s => s.zOrder > 1) && (this.shellScene || surfaces.some(s => s.selections.length))) {
      for(let i=0;i<output.length;i++) output[i]=Math.min(15,(output[i]!+8)>>4)*16
      for(const surface of surfaces) for(const row of surface.selections) paintPresentation(output,screen,this.width,this.height,{...row,x:row.x+surface.x,y:row.y+surface.y,occlusions:row.occlusions.map(r=>({...r,x:r.x+surface.x,y:r.y+surface.y}))})
    }
    if (this.shellScene && !surfaces.some(s => s.zOrder > 1)) {
      const quantize = (v: number) => Math.min(15, (v + 8) >> 4)
      for (let i=0;i<output.length;i++) output[i]=quantize(output[i])*16
      const bytes=this.shellScene, view=new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      let p=2
      for(let i=0;i<view.getUint16(0,true);i++) {
        const x=view.getInt16(p+2,true), y=view.getInt16(p+4,true), w=view.getUint16(p+6,true), h=view.getUint16(p+8,true), dim=view.getUint16(p+10,true), selections=view.getUint16(p+12,true), shift=Math.floor(view.getInt16(p+14,true)/2)
        p+=16
        if(dim<256) for(let j=0;j<output.length;j++) output[j]=Math.floor((output[j]/16)*dim/256)*16
        for(let yy=0;yy<h;yy++) for(let xx=0;xx<w;xx++) {
          if(x+xx+shift>=0 && y+yy>=0 && x+xx+shift<this.width && y+yy<this.height) output[(y+yy)*this.width+x+xx+shift]=quantize(bytes[p+yy*w+xx])*16
        }
        p+=w*h
        for(let j=0;j<selections;j++) { const record=readPresentation(bytes,p);p=record.end;if(record.selection.displayList?.timeline) record.selection.displayList = { ...record.selection.displayList, presentedAt: this.shellReceivedAt, timeline: { ...record.selection.displayList.timeline, startedAt: record.selection.displayList.timeline.startedAt - (Date.now()-this.shellReceivedAt) } };paintPresentation(output,screen,this.width,this.height,record.selection) }
      }
    }
    return output
  }
}
