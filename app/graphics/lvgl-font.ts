/** Reader for the bundled Source Han Sans serialized LVGL font. Matches
 * Android LvglFontFile's metrics/glyph byte format, without a Java dependency. */
export class LvglFont {
  readonly metrics: Uint8Array
  private readonly view: DataView
  private readonly ids = new Map<number, number>()
  private readonly bitmaps: number
  private readonly descriptors: number
  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (bytes.length < 64 || bytes.slice(0, 4).some(v => v !== 90)) throw new Error('Missing LVGL font header')
    const height = this.u16(0x38), baseline = height - this.u16(0x3a)
    const descriptor = this.pointer(this.u32(0x34))
    this.bitmaps = this.pointer(this.u32(descriptor)); this.descriptors = this.pointer(this.u32(descriptor + 4))
    const cmaps = this.pointer(this.u32(descriptor + 8)), packed = this.u16(descriptor + 18), count = packed & 0x1ff
    if (!height || baseline < 0 || !count || ((packed >>> 9) & 15) !== 4 || (packed >>> 14) !== 3) throw new Error('Unsupported LVGL font')
    this.metrics = new Uint8Array([height, baseline])
    for (let i = 0; i < count; i++) {
      const at = cmaps + i * 20, start = this.u32(at), length = this.u16(at + 4), first = this.u16(at + 6)
      const unicodePtr = this.u32(at + 8), offsetsPtr = this.u32(at + 12), listLength = this.u16(at + 16), type = this.u8(at + 18)
      if (type === 2 || type === 0) {
        const offsets = type === 0 ? this.pointer(offsetsPtr) : 0
        for (let n = 0; n < length; n++) {
          const offset = type === 0 ? this.u8(offsets + n) : n
          if (n && !offset) continue
          this.ids.set(start + n, first + offset)
        }
      } else if (type === 1 || type === 3) {
        const unicode = this.pointer(unicodePtr), offsets = offsetsPtr ? this.pointer(offsetsPtr) : -1
        for (let n = 0; n < listLength; n++) {
          const offset = offsets < 0 ? n : type === 1 ? this.u16(offsets + n * 2) : this.u8(offsets + n)
          if (n && !offset) continue
          this.ids.set(start + this.u16(unicode + n * 2), first + offset)
        }
      } else throw new Error('Unsupported LVGL cmap')
    }
  }
  glyph(codePoint: number): Uint8Array {
    const id = this.ids.get(codePoint)
    if (!id) return new Uint8Array()
    const at = this.descriptors + id * 16, bitmap = this.bitmaps + this.u32(at)
    const width = this.u16(at + 8), height = this.u16(at + 10), length = width && height ? (Math.floor(width / 2) + 1) * height : 0
    this.check(bitmap, length)
    const result = new Uint8Array(8 + length)
    result.set(this.bytes.subarray(at + 8, at + 16)); result.set(this.bytes.subarray(bitmap, bitmap + length), 8)
    return result
  }
  private check(at: number, size: number): void { if (at < 0 || at + size > this.bytes.length) throw new Error('Truncated LVGL font') }
  private pointer(address: number): number { const at = address - 0x80100000; this.check(at, 1); return at }
  private u8(at: number): number { this.check(at, 1); return this.bytes[at] }
  private u16(at: number): number { return this.view.getUint16(at, true) }
  private u32(at: number): number { return this.view.getUint32(at, true) }
}
