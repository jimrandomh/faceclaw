import { knownFolders } from "@nativescript/core";

export type Glyph = {
  encoding: number;
  dwidthX: number;
  bbxWidth: number;
  bbxHeight: number;
  bbxX: number;
  bbxY: number;
  bitmapRows: number[];
};

export class BdfFont {
  readonly ascent: number;
  readonly descent: number;
  readonly lineHeight: number;
  readonly defaultChar: number;
  private readonly glyphs: Map<number, Glyph>;

  constructor(opts: {
    ascent: number;
    descent: number;
    defaultChar: number;
    glyphs: Map<number, Glyph>;
  }) {
    this.ascent = opts.ascent;
    this.descent = opts.descent;
    this.lineHeight = opts.ascent + opts.descent;
    this.defaultChar = opts.defaultChar;
    this.glyphs = opts.glyphs;
  }

  static parse(source: string): BdfFont {
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
          if (encoding >= 0) {
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

    return new BdfFont({ ascent, descent, defaultChar, glyphs });
  }

  getGlyph(codePoint: number): Glyph | undefined {
    return this.glyphs.get(codePoint) ?? this.glyphs.get(this.defaultChar) ?? this.glyphs.get(63);
  }

  hasGlyph(codePoint: number): boolean {
    return this.glyphs.has(codePoint);
  }

  measureText(text: string): number {
    let width = 0;
    for (const char of text) {
      width += this.getGlyph(char.codePointAt(0) ?? 32)?.dwidthX ?? 0;
    }
    return width;
  }
}

const cachedEmbeddedFonts = new Map<string, BdfFont>();

export function loadEmbeddedTerminus12(): BdfFont {
  return loadEmbeddedFont("fonts/terminus/ter-u12n.bdf");
}

export function loadEmbeddedTerminus16(): BdfFont {
  return loadEmbeddedFont("fonts/terminus/ter-u16n.bdf");
}

export function loadEmbeddedTerminus24(): BdfFont {
  return loadEmbeddedFont("fonts/terminus/ter-u24n.bdf");
}

export function loadEmbeddedTerminus32(): BdfFont {
  return loadEmbeddedFont("fonts/terminus/ter-u32n.bdf");
}

function loadEmbeddedFont(path: string): BdfFont {
  const cached = cachedEmbeddedFonts.get(path);
  if (cached) {
    return cached;
  }
  const file = knownFolders.currentApp().getFile(path);
  const text = file.readTextSync();
  const font = BdfFont.parse(text);
  cachedEmbeddedFonts.set(path, font);
  return font;
}
