declare const FaceclawFontRenderer: any
function bytes(data: NSData | null): Uint8Array {
  return data ? new Uint8Array(interop.bufferFromData(data)).slice() : new Uint8Array()
}
export const fontRenderer = {
  canLoadFont: (path: string): boolean => !!FaceclawFontRenderer.canLoadFont(path),
  getFontName: (path: string): string => String(FaceclawFontRenderer.getFontName(path) ?? ''),
  getFontMetrics: (path: string, size: number): string => String(FaceclawFontRenderer.getFontMetricsSize(path, size) ?? ''),
  measureTextExact: (path: string, text: string, size: number): number => Number(FaceclawFontRenderer.measureTextExactTextSize(path, text, size)),
  renderGlyphCell: (path: string, size: number, cp: number, gamma: number): Uint8Array => bytes(FaceclawFontRenderer.renderGlyphCellSizeCodePointGamma(path, size, cp, gamma)),
  renderText: (path: string, text: string, size: number, gamma: number): Uint8Array => bytes(FaceclawFontRenderer.renderTextTextSizeGamma(path, text, size, gamma)),
  renderWrapped: (path: string, text: string, size: number, width: number, gamma: number, lines: number): Uint8Array => bytes(FaceclawFontRenderer.renderWrappedTextSizeWidthGammaMaxLines(path, text, size, width, gamma, lines)),
}
