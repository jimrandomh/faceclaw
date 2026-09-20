import { knownFolders } from "@nativescript/core";
import type { GrayImage } from "./image";

export type Glyph = {
  encoding: number;
  dwidthX: number;
  bbxWidth: number;
  bbxHeight: number;
  bbxX: number;
  bbxY: number;
  bitmapRows: number[];
  /**
   * Antialiased coverage, bbxWidth*bbxHeight 4bpp levels (0..15) row-major.
   * When present the glyph is an AA raster (e.g. a TTF render; see
   * ttf-font.ts) and bitmapRows is unused/empty; when absent the glyph is
   * 1bpp via bitmapRows.
   */
  coverage?: Uint8Array;
  /** Exact (fractional) advance in pixels; dwidthX is its integer stand-in. */
  advance?: number;
};

let nextFontFingerprintId = 1;

/**
 * Allocate a process-local font fingerprint id. Shared by every font class
 * that participates in PlacedGlyph fingerprints (BdfFont, TtfFont) so ids
 * never collide across font kinds.
 */
export function allocateFontFingerprintId(): number {
  return nextFontFingerprintId++;
}

export class BdfFont {
  /**
   * Process-local identity for content fingerprints (fonts are cached
   * singletons, so two draws with the same id + encoding are the same glyph
   * bitmap). Only meaningful within one JS context; never persist it.
   */
  readonly fingerprintId = allocateFontFingerprintId();
  /**
   * Stable cross-context identity for the on-glasses glyph atlas (the
   * embedded font name). Worker threads and the main thread must agree on
   * it, unlike fingerprintId. Fonts without one (ad-hoc parses) simply never
   * participate in texture caching — their glyphs stay baked.
   */
  readonly atlasKey: string | null;
  readonly ascent: number;
  readonly descent: number;
  readonly lineHeight: number;
  readonly defaultChar: number;
  /**
   * Font consulted for code points this font has no glyph for. Used so a
   * partial-coverage face (e.g. TerminusV, which only ships ISO-8859-1) can
   * borrow glyphs from a full-coverage face of the same pixel height. The
   * fallback's glyphs are drawn with *this* font's ascent, so the two must
   * share a baseline (ascent/descent) for the result to line up.
   */
  private readonly fallback?: BdfFont;
  private readonly glyphs: Map<number, Glyph>;

  constructor(opts: {
    ascent: number;
    descent: number;
    defaultChar: number;
    glyphs: Map<number, Glyph>;
    fallback?: BdfFont;
    atlasKey?: string;
  }) {
    this.ascent = opts.ascent;
    this.descent = opts.descent;
    this.lineHeight = opts.ascent + opts.descent;
    this.defaultChar = opts.defaultChar;
    this.glyphs = opts.glyphs;
    this.fallback = opts.fallback;
    this.atlasKey = opts.atlasKey ?? null;
  }

  static parse(source: string, opts: { fallback?: BdfFont; minEncoding?: number; atlasKey?: string } = {}): BdfFont {
    const minEncoding = opts.minEncoding ?? 0;
    const lines = source.replace(/\r/g, "").split("\n");
    let ascent = 10;
    let descent = 2;
    let defaultChar = 63;
    const glyphs = new Map<number, Glyph>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.startsWith("FONT_ASCENT ")) {
        ascent = parseInt(line.slice("FONT_ASCENT ".length), 10);
        continue;
      }
      if (line.startsWith("FONT_DESCENT ")) {
        descent = parseInt(line.slice("FONT_DESCENT ".length), 10);
        continue;
      }
      if (line.startsWith("DEFAULT_CHAR ")) {
        defaultChar = parseInt(line.slice("DEFAULT_CHAR ".length), 10);
        continue;
      }
      if (!line.startsWith("STARTCHAR ")) {
        continue;
      }

      let encoding = -1;
      let dwidthX = 0;
      let bbxWidth = 0;
      let bbxHeight = 0;
      let bbxX = 0;
      let bbxY = 0;
      const bitmapRows: number[] = [];

      for (i = i + 1; i < lines.length; i++) {
        const inner = lines[i]!;
        if (inner.startsWith("ENCODING ")) {
          encoding = parseInt(inner.slice("ENCODING ".length), 10);
          continue;
        }
        if (inner.startsWith("DWIDTH ")) {
          dwidthX = parseInt(inner.slice("DWIDTH ".length).split(/\s+/)[0]!, 10);
          continue;
        }
        if (inner.startsWith("BBX ")) {
          const [w, h, x, y] = inner
            .slice("BBX ".length)
            .split(/\s+/)
            .map((value) => parseInt(value, 10));
          bbxWidth = w!;
          bbxHeight = h!;
          bbxX = x!;
          bbxY = y!;
          continue;
        }
        if (inner === "BITMAP") {
          for (let row = 0; row < bbxHeight && i + 1 < lines.length; row++) {
            const bitmapLine = lines[++i]!;
            bitmapRows.push(parseInt(bitmapLine || "0", 16) || 0);
          }
          continue;
        }
        if (inner === "ENDCHAR") {
          if (encoding >= minEncoding) {
            glyphs.set(encoding, {
              encoding,
              dwidthX: dwidthX || bbxWidth,
              bbxWidth,
              bbxHeight,
              bbxX,
              bbxY,
              bitmapRows,
            });
          }
          break;
        }
      }
    }

    return new BdfFont({ ascent, descent, defaultChar, glyphs, fallback: opts.fallback, atlasKey: opts.atlasKey });
  }

  /** Exact lookup for a single code point, with no default-char substitution. */
  private getExactGlyph(codePoint: number): Glyph | undefined {
    return this.glyphs.get(codePoint) ?? this.fallback?.getExactGlyph(codePoint);
  }

  getGlyph(codePoint: number): Glyph | undefined {
    return (
      this.getExactGlyph(codePoint) ??
      this.glyphs.get(this.defaultChar) ??
      this.glyphs.get(63) ??
      this.fallback?.getGlyph(codePoint)
    );
  }

  hasGlyph(codePoint: number): boolean {
    return this.glyphs.has(codePoint) || (this.fallback?.hasGlyph(codePoint) ?? false);
  }

  measureText(text: string): number {
    let width = 0;
    for (const char of text) {
      width += this.getGlyph(char.codePointAt(0) ?? 32)?.dwidthX ?? 0;
    }
    return width;
  }

  /**
   * Draw text with integer advances, recording each glyph as a deferred draw
   * on the image (UiFont contract; y is the top of the line).
   */
  drawText(image: GrayImage, x: number, y: number, text: string, value: number): void {
    let cursorX = x;
    for (const char of text) {
      if (char === "\n") {
        cursorX = x;
        y += this.lineHeight;
        continue;
      }
      const glyph = this.getGlyph(char.codePointAt(0) ?? 32);
      if (!glyph) continue;
      image.drawGlyph(this, glyph, cursorX, y, value);
      cursorX += glyph.dwidthX;
    }
  }
}

const embeddedFonts = {
  "terminus12": "fonts/terminus/ter-u12n.bdf",
  "terminus16": "fonts/terminus/ter-u16n.bdf",
  "terminus24": "fonts/terminus/ter-u24n.bdf",
  "terminus32": "fonts/terminus/ter-u32n.bdf",
  // TerminusV is a proportional (variable-width) Terminus derivative that only
  // covers ISO-8859-1. At 12px it shares Terminus's baseline, so we fall back
  // to Terminus 12 for any code point outside Latin-1. minEncoding 32 drops
  // TerminusV's private low-encoding drawing glyphs so control code points fall
  // through to Terminus too.
  "terminusv12": "fonts/terminusv/terv12n.bdf",
} as const;
type EmbeddedFontName = keyof typeof embeddedFonts;

const fontFallbacks: Partial<Record<EmbeddedFontName, EmbeddedFontName>> = {
  terminusv12: "terminus12",
};
const fontMinEncoding: Partial<Record<EmbeddedFontName, number>> = {
  terminusv12: 32,
};

const cachedEmbeddedFonts = new Map<EmbeddedFontName, BdfFont>();

function loadEmbeddedFont(name: EmbeddedFontName): BdfFont {
  const cached = cachedEmbeddedFonts.get(name);
  if (cached) {
    return cached;
  }
  const file = knownFolders.currentApp().getFile(embeddedFonts[name]);
  const text = file.readTextSync();
  const fallbackName = fontFallbacks[name];
  const font = BdfFont.parse(text, {
    fallback: fallbackName ? loadEmbeddedFont(fallbackName) : undefined,
    minEncoding: fontMinEncoding[name],
    atlasKey: name,
  });
  cachedEmbeddedFonts.set(name, font);
  return font;
}

export function getFont(font: EmbeddedFontName): BdfFont {
  return loadEmbeddedFont(font);
}

// NOTE: the default UI font getters (getDefaultSmallFont & co.) live in
// ./ui-fonts, which resolves the user's font settings to a BdfFont or
// TtfFont. This module stays a pure BDF loader.
