/** Platform boundary for font rasterization; layout and glyph caches stay shared. */
import { toUint8Array } from '../util/array-util'
declare const com: any
export const fontRenderer = {
  canLoadFont: (path: string): boolean => !!com.faceclaw.app.FontFileRenderer.canLoadFont(path),
  getFontName: (path: string): string => String(com.faceclaw.app.FontFileRenderer.getFontName(path) ?? ''),
  getFontMetrics: (path: string, size: number): string => String(com.faceclaw.app.FontFileRenderer.getFontMetrics(path, size) ?? ''),
  measureTextExact: (path: string, text: string, size: number): number => Number(com.faceclaw.app.FontFileRenderer.measureTextExact(path, text, size)),
  renderGlyphCell: (path: string, size: number, cp: number, gamma: number): Uint8Array => toUint8Array(com.faceclaw.app.FontFileRenderer.renderGlyphCell(path, size, cp, gamma)),
  renderText: (path: string, text: string, size: number, gamma: number): Uint8Array => toUint8Array(com.faceclaw.app.FontFileRenderer.renderText(path, text, size, gamma)),
  renderWrapped: (path: string, text: string, size: number, width: number, gamma: number, lines: number): Uint8Array => toUint8Array(com.faceclaw.app.FontFileRenderer.renderWrapped(path, text, size, width, gamma, lines)),
}
