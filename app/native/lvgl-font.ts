import { toUint8Array } from '../util/array-util'
declare const com: any
export function lvglMetrics(path: string): Uint8Array { return toUint8Array(com.faceclaw.app.LvglFontFile.getMetrics(path)) }
export function lvglGlyph(path: string, codePoint: number): Uint8Array { return toUint8Array(com.faceclaw.app.LvglFontFile.getGlyph(path, codePoint)) }
