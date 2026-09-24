import { DrawBytes, encodeValue, evaluate, integer, readValue, type DrawValue } from './draw-expression';

/** Local resources are assigned firmware cache IDs by Kotlin. SCREEN reads the uncomposed frame. */
export const SCREEN = 65535;
export const DrawOp = { RECT_COPY: 2, IMAGE: 4, ROUNDED_RECT: 8 } as const;
export const DISPLAY_LIST_RECORD = 7;
export type ListImage = { readonly width: number; readonly height: number; readonly pixels: Uint8Array };
export type ListCall = (
  | { op: typeof DrawOp.ROUNDED_RECT; x: DrawValue; y: DrawValue; width: number; height: number; radius: number; background: number; border: number }
  | { op: typeof DrawOp.IMAGE; resource: number; x: number; y: number; transparent: boolean }
  | { op: typeof DrawOp.RECT_COPY; resource: number; x: DrawValue; y: DrawValue; width: number; height: number; dx: DrawValue; dy: DrawValue }
) & { depth?: number };
export type DisplayList = {
  readonly resources: readonly ListImage[];
  readonly calls: readonly ListCall[];
  /** Stable identity plus JS clock origin. Native binds ELAPSED again for each PRESENT. */
  /** Set by the decoder: the local PRESENT origin for software replay. */
  readonly presentedAt?: number;
  readonly timeline?: { readonly token: number; readonly startedAt: number };
};
export type PlacedDisplayList = { displayList: DisplayList; x: number; y: number; width: number; height: number; depth: number };

class Writer {
  bytes: number[] = [];
  u8(n: number): void { this.bytes.push(integer(n, 0, 255)); }
  i8(n: number): void { this.u8(integer(n, -128, 127) & 255); }
  u16(n: number): void { integer(n, 0, 65535); this.bytes.push(n & 255, n >>> 8); }
  i16(n: number): void { this.u16(integer(n, -32768, 32767) & 65535); }
  u32(n: number): void { integer(n, 0, 4294967295); this.u16(n & 65535); this.u16(n >>> 16); }
  raw(bytes: ArrayLike<number>): void { for (let i = 0; i < bytes.length; i++) this.bytes.push(bytes[i]); }
}

/** Length-delimited bridge envelope; call operands use fixed widths except extended x/y. */
export function encodeDisplayList(placed: PlacedDisplayList, now = Date.now()): Uint8Array {
  const { displayList: list } = placed, out = new Writer();
  integer(placed.width, 1, 640); integer(placed.height, 1, 480);
  out.i16(placed.x); out.i16(placed.y); out.u16(placed.width); out.u16(placed.height); out.i8(placed.depth);
  out.u32(list.timeline?.token ?? 0);
  out.u32(list.timeline ? Math.min(2147483647, Math.max(0, Math.trunc(now - list.timeline.startedAt))) : 0);
  integer(list.resources.length, 0, 256); out.u16(list.resources.length);
  for (const image of list.resources) {
    integer(image.width, 1, 640); integer(image.height, 1, 480);
    if (image.pixels.length !== image.width * image.height || 5 + Math.ceil(image.width / 2) * image.height > 65536) throw new Error('Invalid display-list image');
    out.u16(image.width); out.u16(image.height); out.raw(image.pixels);
  }
  integer(list.calls.length, 0, 4096); out.u16(list.calls.length);
  for (const call of list.calls) {
    out.u8(call.op); out.i16(call.depth ?? 0);
    integer(placed.depth + (call.depth ?? 0), -128, 127);
    if (call.op === DrawOp.ROUNDED_RECT) {
      out.raw(encodeValue(call.x)); out.raw(encodeValue(call.y));
      out.u16(integer(call.width, 1, 640)); out.u16(integer(call.height, 1, 480)); out.u16(call.radius);
      out.u8(integer(call.background, 0, 15)); out.u8(integer(call.border, 0, 16));
    } else {
      if (call.resource !== SCREEN) integer(call.resource, 0, list.resources.length - 1);
      if (call.op === DrawOp.RECT_COPY && call.resource !== SCREEN && [call.x, call.y].some(v => typeof v === 'number' && v < 0)) throw new Error('Negative image source coordinate');
      if (call.op === DrawOp.IMAGE && call.resource === SCREEN) throw new Error('Use rectCopy to read SCREEN');
      out.u16(call.resource);
      if (call.op === DrawOp.IMAGE) { out.i16(call.x); out.i16(call.y); out.u8(call.transparent ? 31 : 15); }
      else {
        out.raw(encodeValue(call.x)); out.raw(encodeValue(call.y)); out.u16(integer(call.width, 1, 640)); out.u16(integer(call.height, 1, 480));
        out.raw(encodeValue(call.dx)); out.raw(encodeValue(call.dy));
      }
    }
  }
  if (out.bytes.length > 4 * 1024 * 1024) throw new Error('Display list exceeds bridge limit');
  const header = new Writer(); header.u8(DISPLAY_LIST_RECORD); header.u32(out.bytes.length); header.raw(out.bytes);
  return Uint8Array.from(header.bytes);
}

export function readDisplayList(bytes: Uint8Array, offset: number, now = Date.now()): { placed: PlacedDisplayList; end: number } {
  const envelope = new DrawBytes(bytes.subarray(offset));
  if (envelope.u8() !== DISPLAY_LIST_RECORD) throw new Error('Invalid display-list record');
  const length = envelope.u32(); integer(length, 0, 4 * 1024 * 1024);
  const r = new DrawBytes(envelope.take(length));
  const x = r.i16(), y = r.i16(), width = r.u16(), height = r.u16(), depth = r.u8() << 24 >> 24;
  const token = r.u32(), elapsed = r.u32(), count = r.u16(); integer(count, 0, 256);
  const resources: ListImage[] = [];
  for (let i = 0; i < count; i++) { const width = r.u16(), height = r.u16(); resources.push({ width, height, pixels: r.take(width * height) }); }
  const calls: ListCall[] = [], callCount = r.u16(); integer(callCount, 0, 4096);
  for (let i = 0; i < callCount; i++) {
    const op = r.u8(), depth = r.i16();
    if (op === DrawOp.ROUNDED_RECT) calls.push({ op, depth, x: readValue(r), y: readValue(r), width: r.u16(), height: r.u16(), radius: r.u16(), background: r.u8(), border: r.u8() });
    else if (op === DrawOp.IMAGE) calls.push({ op, depth, resource: r.u16(), x: r.i16(), y: r.i16(), transparent: (r.u8() & 16) !== 0 });
    else if (op === DrawOp.RECT_COPY) calls.push({ op, depth, resource: r.u16(), x: readValue(r), y: readValue(r), width: r.u16(), height: r.u16(), dx: readValue(r), dy: readValue(r) });
    else throw new Error('Unsupported display-list call');
  }
  if (r.offset !== length) throw new Error('Trailing display-list bytes');
  const placed = { x, y, width, height, depth, displayList: { resources, calls, presentedAt: now, timeline: { token, startedAt: now - elapsed } } };
  // The writer is also the shared structural validator for software preview records.
  encodeDisplayList(placed, now);
  return { placed, end: offset + envelope.offset };
}

export function dimDisplayList(list: DisplayList, factor: number): DisplayList {
  const dim = (v: number) => v === 0 ? 0 : Math.max(1, Math.round(v * factor));
  return { ...list, resources: list.resources.map(r => ({ ...r, pixels: r.pixels.map(dim) })),
    calls: list.calls.map(c => c.op === DrawOp.ROUNDED_RECT ? { ...c, background: Math.min(15, Math.round(c.background * factor)), border: c.border === 16 ? 16 : Math.min(15, Math.round(c.border * factor)) } : c) };
}

/** Fallback compositor; native preview and glasses replay the compiled list with their existing timers. */
export function paintDisplayList(output: Uint8Array, screen: Uint8Array, width: number, height: number, placed: PlacedDisplayList, right = false, now = Date.now()): void {
  const q = (n: number) => Math.min(15, (n + 8) >> 4) * 16;
  const list = placed.displayList;
  const elapsed = list.timeline ? Math.max(0, (list.presentedAt ?? now) - list.timeline.startedAt) : 0;
  const presentTime = list.presentedAt === undefined ? 0 : Math.max(0, now - list.presentedAt);
  const inside = (x: number, y: number, w: number, h: number, radius: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const r = Math.min(radius, Math.floor(w / 2), Math.floor(h / 2));
    const dx = Math.max(0, 2 * r - (2 * Math.min(x, w - 1 - x) + 1)), dy = Math.max(0, 2 * r - (2 * Math.min(y, h - 1 - y) + 1));
    return dx * dx + dy * dy <= 4 * r * r;
  };
  for (const c of placed.displayList.calls) {
    const depth = placed.depth + (c.depth ?? 0), shift = right ? -Math.floor((depth + 1) / 2) : Math.floor(depth / 2);
    if (c.op === DrawOp.ROUNDED_RECT) {
      const x = placed.x + evaluate(c.x, elapsed, presentTime).value + shift, y = placed.y + evaluate(c.y, elapsed, presentTime).value;
      for (let yy = 0; yy < c.height; yy++) for (let xx = 0; xx < c.width; xx++) {
        if (x + xx < 0 || y + yy < 0 || x + xx >= width || y + yy >= height || !inside(xx, yy, c.width, c.height, c.radius)) continue;
        const p = (y + yy) * width + x + xx;
        output[p] = c.border !== 16 && !inside(xx - 1, yy - 1, c.width - 2, c.height - 2, Math.max(0, c.radius - 1)) ? c.border * 16 : Math.max(output[p], c.background * 16);
      }
    } else {
      const source = c.resource === SCREEN ? { width, height, pixels: screen } : placed.displayList.resources[c.resource];
      const w = c.op === DrawOp.IMAGE ? source.width : c.width, h = c.op === DrawOp.IMAGE ? source.height : c.height;
      const at = (v: DrawValue) => evaluate(v, elapsed, presentTime).value;
      const sx = c.op === DrawOp.IMAGE ? 0 : at(c.x) + (c.resource === SCREEN ? placed.x : 0), sy = c.op === DrawOp.IMAGE ? 0 : at(c.y) + (c.resource === SCREEN ? placed.y : 0);
      const x = placed.x + (c.op === DrawOp.IMAGE ? c.x : at(c.dx)) + shift, y = placed.y + (c.op === DrawOp.IMAGE ? c.y : at(c.dy));
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        if (x + xx < 0 || y + yy < 0 || x + xx >= width || y + yy >= height || sx + xx < 0 || sy + yy < 0 || sx + xx >= source.width || sy + yy >= source.height) continue;
        const v = q(source.pixels[(sy + yy) * source.width + sx + xx]);
        if (c.op !== DrawOp.IMAGE || !c.transparent || v !== 0) output[(y + yy) * width + x + xx] = v;
      }
    }
  }
}
