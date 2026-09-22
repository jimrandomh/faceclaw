import type { PlacedImage } from './image'

/** Bridge record: tag 3 (selection), 4 (image), 5 (gray8-masked image), signed xy, u16 wh/radius, gray fill/stroke, signed depth, restore-count, gray pixels, restore rectangles. */
export function encodePresentation(draw: PlacedImage): Uint8Array {
  const p = draw.presentation!
  const { width, height, pixels } = draw.source
  if (width < 1 || height < 1 || width > 640 || height > 480 || 5 + Math.ceil(width / 2) * height > 65536) throw new Error('Presentation image exceeds the resource size limit')
  if (!Number.isInteger(p.depth) || p.depth < -128 || p.depth > 127) throw new Error('Invalid menu depth')
  if ((p.occlusions?.length ?? 0) > 2048) throw new Error('Too many menu occlusion rectangles')
  const bytes = new Uint8Array(16 + width * height + (p.occlusions?.length ?? 0) * 8), view = new DataView(bytes.buffer)
  bytes[0] = p.mode === "image" ? 4 : p.mode === "masked-image" ? 5 : 3
  view.setInt16(1, draw.x, true); view.setInt16(3, draw.y, true)
  view.setUint16(5, width, true); view.setUint16(7, height, true); view.setUint16(9, p.radius, true)
  bytes[11] = p.background; bytes[12] = p.border; view.setInt8(13, p.depth)
  view.setUint16(14, p.occlusions?.length ?? 0, true)
  bytes.set(pixels, 16)
  let offset = 16 + pixels.length
  for (const rect of p.occlusions ?? []) {
    view.setUint16(offset, rect.x, true); view.setUint16(offset + 2, rect.y, true)
    view.setUint16(offset + 4, rect.width, true); view.setUint16(offset + 6, rect.height, true); offset += 8
  }
  return bytes
}

export type Selection = { mode?: "image" | "masked-image"; x: number; y: number; width: number; height: number; radius: number; background: number; border: number; depth: number; pixels: Uint8Array; occlusions: { x: number; y: number; width: number; height: number }[] }
export function readPresentation(bytes: Uint8Array, offset: number): { selection: Selection; end: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), w = v.getUint16(offset + 5, true), h = v.getUint16(offset + 7, true)
  const selection: Selection = { mode: bytes[offset] === 4 ? "image" : bytes[offset] === 5 ? "masked-image" : undefined, x: v.getInt16(offset+1,true), y: v.getInt16(offset+3,true), width:w, height:h,
    radius:v.getUint16(offset+9,true), background:bytes[offset+11]!, border:bytes[offset+12]!, depth:v.getInt8(offset+13),
    pixels:bytes.slice(offset+16,offset+16+w*h), occlusions:[] }
  let end=offset+16+w*h
  for(let i=0;i<v.getUint16(offset+14,true);i++) { selection.occlusions.push({x:v.getUint16(end,true),y:v.getUint16(end+2,true),width:v.getUint16(end+4,true),height:v.getUint16(end+6,true)});end+=8 }
  return {selection,end}
}
export function presentationRecords(buffer: ArrayBuffer | null): Selection[] {
  if (!buffer) return []
  const bytes=new Uint8Array(buffer), result:Selection[]=[]
  for(let p=0;p<bytes.length;) {
    if(bytes[p]===3 || bytes[p]===4 || bytes[p]===5) { const record=readPresentation(bytes,p);result.push(record.selection);p=record.end }
    else if(bytes[p]===0) p+=12
    else if(bytes[p]===1) p+=9
    else if(bytes[p]===2) p+=7+bytes[p+6]!*7
    else break
  }
  return result
}
export function paintPresentation(output: Uint8Array, screen: Uint8Array, width: number, height: number, row: Selection, right = false): void {
  const q=(n:number)=>Math.min(15,(n+8)>>4), shift=right?-Math.floor((row.depth+1)/2):Math.floor(row.depth/2)
  const inside=(x:number,y:number,w:number,h:number,r:number)=>{
    if(x<0||y<0||x>=w||y>=h) return false
    r=Math.min(r,Math.floor(w/2),Math.floor(h/2))
    const dx=Math.max(0,2*r-(2*Math.min(x,w-1-x)+1)),dy=Math.max(0,2*r-(2*Math.min(y,h-1-y)+1))
    return dx*dx+dy*dy<=4*r*r
  }
  for(let yy=0;yy<row.height;yy++) for(let xx=0;xx<row.width;xx++) {
    const x=row.x+xx+shift,y=row.y+yy
    if(x<0||y<0||x>=width||y>=height) continue
    const i=y*width+x
    if(!row.mode && inside(xx,yy,row.width,row.height,row.radius)) output[i]=!inside(xx-1,yy-1,row.width-2,row.height-2,Math.max(0,row.radius-1))?q(row.border)*16:Math.max(output[i]!,q(row.background)*16)
    const value=q(row.pixels[yy*row.width+xx]!)
    if(row.mode === "masked-image" ? row.pixels[yy*row.width+xx] !== 0 : value !== 0) output[i]=value*16
  }
  for(const r of row.occlusions) for(let yy=r.y;yy<r.y+r.height;yy++) for(let xx=r.x;xx<r.x+r.width;xx++) if(xx>=0&&yy>=0&&xx<width&&yy<height) output[yy*width+xx]=q(screen[yy*width+xx]!)*16
}
