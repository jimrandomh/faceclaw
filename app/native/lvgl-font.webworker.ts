/** LVGL fonts parse in Kotlin, which workers don't load: the callers fall back to their other faces. */
export function lvglMetrics(_path: string): Uint8Array { return new Uint8Array(); }
export function lvglGlyph(_path: string, _codePoint: number): Uint8Array { return new Uint8Array(); }
