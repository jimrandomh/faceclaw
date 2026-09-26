import type { PlacedImage } from './image'
import { DISPLAY_LIST_RECORD, DrawOp, SCREEN, encodeDisplayList, readDisplayList, paintDisplayList, type DisplayList } from './display-list'

/** TS/native bridge tags, not firmware draw opcodes. Keep in sync with DrawRecordKind.kt. */
export const DrawRecordKind = {
  GLYPH: 0,
  TEXTURE_IMAGE: 1,
  FIRMWARE_TEXT: 2,
  MENU_SELECTION: 3,
  TRANSPARENT_IMAGE: 4,
  MASKED_IMAGE: 5,
  DISPLAY_LIST: DISPLAY_LIST_RECORD,
} as const

export function isPresentationKind(kind: number | undefined): boolean {
  return kind === DrawRecordKind.MENU_SELECTION || kind === DrawRecordKind.TRANSPARENT_IMAGE ||
    kind === DrawRecordKind.MASKED_IMAGE || kind === DrawRecordKind.DISPLAY_LIST
}

/** Presentation record: tag, signed xy, u16 wh/radius, gray fill/stroke, signed depth, restore-count, gray pixels, restore rectangles. */
export function encodePresentation(draw: PlacedImage): Uint8Array {
  const p = draw.presentation!
  const { width, height, pixels } = draw.source
  if (width < 1 || height < 1 || width > 640 || height > 480 || !p.displayList && 5 + Math.ceil(width / 2) * height > 65536) throw new Error('Presentation image exceeds the resource size limit')
  if (!Number.isInteger(p.depth) || p.depth < -128 || p.depth > 127) throw new Error('Invalid menu depth')
  if ((p.occlusions?.length ?? 0) > 2048) throw new Error('Too many menu occlusion rectangles')
  if (p.displayList) {
    const calls = [...p.displayList.calls, ...(p.occlusions ?? []).map(r => ({
      op: DrawOp.RECT_COPY, resource: SCREEN, x: r.x - draw.x, y: r.y - draw.y,
      width: r.width, height: r.height, dx: r.x - draw.x, dy: r.y - draw.y, depth: -p.depth,
    }))];
    return encodeDisplayList({ displayList: { ...p.displayList, calls }, x: draw.x, y: draw.y, width, height, depth: p.depth });
  }
  const header = 16;
  const bytes = new Uint8Array(header + width * height + (p.occlusions?.length ?? 0) * 8), view = new DataView(bytes.buffer)
  bytes[0] = p.mode === "image" ? DrawRecordKind.TRANSPARENT_IMAGE
    : p.mode === "masked-image" ? DrawRecordKind.MASKED_IMAGE : DrawRecordKind.MENU_SELECTION
  view.setInt16(1, draw.x, true); view.setInt16(3, draw.y, true)
  view.setUint16(5, width, true); view.setUint16(7, height, true); view.setUint16(9, p.radius, true)
  bytes[11] = p.background; bytes[12] = p.border; view.setInt8(13, p.depth)
  view.setUint16(14, p.occlusions?.length ?? 0, true)
  bytes.set(pixels, header)
  let offset = header + pixels.length
  for (const rect of p.occlusions ?? []) {
    view.setUint16(offset, rect.x, true); view.setUint16(offset + 2, rect.y, true)
    view.setUint16(offset + 4, rect.width, true); view.setUint16(offset + 6, rect.height, true); offset += 8
  }
  return bytes
}

export type Selection = { displayList?: DisplayList; mode?: "image" | "masked-image"; x: number; y: number; width: number; height: number; radius: number; background: number; border: number; depth: number; pixels: Uint8Array; occlusions: { x: number; y: number; width: number; height: number }[] }
export function readPresentation(bytes: Uint8Array, offset: number): { selection: Selection; end: number } {
  if (bytes[offset] === DrawRecordKind.DISPLAY_LIST) {
    const { placed, end } = readDisplayList(bytes, offset);
    return { selection: { ...placed, radius: 0, background: 0, border: 0, pixels: new Uint8Array(0), occlusions: [] }, end };
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), w = v.getUint16(offset + 5, true), h = v.getUint16(offset + 7, true)
  const kind = bytes[offset]
  const header = 16
  const selection: Selection = { mode: kind === DrawRecordKind.TRANSPARENT_IMAGE ? "image" : kind === DrawRecordKind.MASKED_IMAGE ? "masked-image" : undefined, x: v.getInt16(offset+1,true), y: v.getInt16(offset+3,true), width:w, height:h,
    radius:v.getUint16(offset+9,true), background:bytes[offset+11]!, border:bytes[offset+12]!, depth:v.getInt8(offset+13),
    pixels:bytes.slice(offset+header,offset+header+w*h), occlusions:[] }
  let end=offset+header+w*h
  for(let i=0;i<v.getUint16(offset+14,true);i++) { selection.occlusions.push({x:v.getUint16(end,true),y:v.getUint16(end+2,true),width:v.getUint16(end+4,true),height:v.getUint16(end+6,true)});end+=8 }
  return {selection,end}
}
export function presentationRecords(buffer: ArrayBuffer | null): Selection[] {
  if (!buffer) return []
  const bytes=new Uint8Array(buffer), result:Selection[]=[]
  for(let p=0;p<bytes.length;) {
    if(isPresentationKind(bytes[p])) { const record=readPresentation(bytes,p);result.push(record.selection);p=record.end }
    else if(bytes[p]===DrawRecordKind.GLYPH) p+=12
    else if(bytes[p]===DrawRecordKind.TEXTURE_IMAGE) p+=9
    else if(bytes[p]===DrawRecordKind.FIRMWARE_TEXT) p+=7+bytes[p+6]!*7
    else break
  }
  return result
}
export function paintPresentation(output: Uint8Array, screen: Uint8Array, width: number, height: number, row: Selection, right = false): void {
  if (row.displayList) { paintDisplayList(output, screen, width, height, { ...row, displayList: row.displayList }, right); return; }
  const q=(n:number)=>Math.min(15,(n+8)>>4), shift=right?-Math.floor((row.depth+1)/2):Math.floor(row.depth/2)
  const inside=(x:number,y:number,w:number,h:number,r:number)=>{
    if(x<0||y<0||x>=w||y>=h) return false
    r=Math.min(r,Math.floor(w/2),Math.floor(h/2))
    const dx=Math.max(0,2*r-(2*Math.min(x,w-1-x)+1)),dy=Math.max(0,2*r-(2*Math.min(y,h-1-y)+1))
    return dx*dx+dy*dy<=4*r*r
  }
  const highlightX = row.x, highlightY = row.y
  if (!row.mode) for(let yy=0;yy<row.height;yy++) for(let xx=0;xx<row.width;xx++) {
    const x=highlightX+xx+shift,y=highlightY+yy
    if(x<0||y<0||x>=width||y>=height || !inside(xx,yy,row.width,row.height,row.radius)) continue
    const i=y*width+x
    output[i]=!inside(xx-1,yy-1,row.width-2,row.height-2,Math.max(0,row.radius-1))?q(row.border)*16:Math.max(output[i]!,q(row.background)*16)
  }
  for(let yy=0;yy<row.height;yy++) for(let xx=0;xx<row.width;xx++) {
    const x=row.x+xx+shift,y=row.y+yy
    if(x<0||y<0||x>=width||y>=height) continue
    const value=q(row.pixels[yy*row.width+xx]!)
    if(row.mode === "masked-image" ? row.pixels[yy*row.width+xx] !== 0 : value !== 0) output[y*width+x]=value*16
  }
  for(const r of row.occlusions) for(let yy=r.y;yy<r.y+r.height;yy++) for(let xx=r.x;xx<r.x+r.width;xx++) if(xx>=0&&yy>=0&&xx<width&&yy<height) output[yy*width+xx]=q(screen[yy*width+xx]!)*16
}
