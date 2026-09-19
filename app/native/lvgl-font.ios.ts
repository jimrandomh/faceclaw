import { fromData } from './kotlin-data'
declare const FaceclawKitIosProtocol: any
const protocol = FaceclawKitIosProtocol.new()
export function lvglMetrics(path: string): Uint8Array { return fromData(protocol.fontMetricsPath(path)) }
export function lvglGlyph(path: string, codePoint: number): Uint8Array { return fromData(protocol.fontGlyphPathCodePoint(path, codePoint)) }
