import { LvglFont } from '../graphics/lvgl-font'
import { readBinaryFile } from './file-access'
const cache = new Map<string, LvglFont>()
function load(path: string): LvglFont {
  let font = cache.get(path)
  if (!font) {
    const bytes = readBinaryFile(path)
    if (!bytes) throw new Error('Cannot read LVGL font')
    font = new LvglFont(bytes)
    if (cache.size >= 2) cache.delete(cache.keys().next().value!)
    cache.set(path, font)
  }
  return font
}
export function lvglMetrics(path: string): Uint8Array { return load(path).metrics }
export function lvglGlyph(path: string, codePoint: number): Uint8Array { return load(path).glyph(codePoint) }
