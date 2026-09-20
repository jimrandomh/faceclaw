/**
 * TTF/OTF fonts for on-glasses UI text, rendered per-codepoint through the
 * native font renderer (Android Paint / iOS Core Text) and cached as 4bpp coverage rasters that ride the
 * texture-cache glyph pipeline (CFW mode 14; see
 * notes/texture-cache-display-list-design.md and graphics/glyph-wire.ts).
 *
 * Layout model: the font owns drawText (like EvenHubFont) because TTF
 * advances are fractional and kerned, which GrayImage.drawText's integer
 * cursor walk can't express. Each glyph is recorded as a deferred
 * PlacedGlyph at an integer pen x, so the wire path and the phone-side bake
 * (rasterizeGlyph's coverage branch, firmware-LUT-exact) see identical
 * positions; the fractional pen accumulates across the line so rounding
 * never drifts.
 *
 * Kerning uses memoized per-pair measurements (measure("ab") - a - b);
 * ligatures are disabled native-side so per-codepoint rasters plus pairwise
 * kerning fully describe a line. Glyph rasters and advances come from one
 * native render per (font, size, codepoint) per JS context, memoized forever.
 *
 * Cross-context determinism: worker threads and the main thread each build
 * their own TtfFont, but the Java GlyphAtlas dedupes by atlasKey and treats
 * rasters as immutable — safe because renderGlyphCell is deterministic for a
 * given (path, size, gamma), all of which are baked into the atlasKey.
 */
import { allocateFontFingerprintId, type Glyph } from "./bdffont";
import { GrayImage, grayToNibble, type GlyphFont } from "./image";
import { toUint8Array } from "../util/array-util";
import { fontRenderer } from "../native/font-renderer";

declare const global: any;

/**
 * Coverage-to-shade gamma (out = coverage^gamma). The G2 display response
 * looks roughly linear, so 1.0; part of the atlas identity, so changing it
 * per-font is safe but changing it per-draw is not possible.
 */
const DEFAULT_TTF_GAMMA = 1.0;

const loadedFonts = new Map<string, TtfFont | null>();

export class TtfFont implements GlyphFont {
  readonly fingerprintId = allocateFontFingerprintId();
  /** Stable cross-context atlas identity: face + size + gamma. */
  readonly atlasKey: string;
  readonly ascent: number;
  readonly descent: number;
  readonly lineHeight: number;
  private readonly glyphCache = new Map<number, Glyph | null>();
  private readonly kernCache = new Map<number, number>();

  private constructor(
    readonly path: string,
    readonly sizePx: number,
    readonly gamma: number,
    ascent: number,
    descent: number,
  ) {
    this.ascent = ascent;
    this.descent = descent;
    this.lineHeight = ascent + descent;
    const basename = path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
    this.atlasKey = `ttf:${basename}:${fnv32(path).toString(36)}@${sizePx}g${gamma}`;
  }

  /**
   * Load (or return the memoized) font at a pixel size. Null when the font
   * file is missing/unloadable or the platform has no renderer — callers fall back to a BDF
   * face.
   */
  static load(path: string, sizePx: number, gamma = DEFAULT_TTF_GAMMA): TtfFont | null {
    const key = `${path}@${sizePx}g${gamma}`;
    const cached = loadedFonts.get(key);
    if (cached !== undefined) return cached;
    let font: TtfFont | null = null;
    if ((global.isAndroid || global.isIOS) && Number.isFinite(sizePx) && sizePx > 0) {
      try {
        const raw = String(fontRenderer.getFontMetrics(path, sizePx) ?? "");
        const parts = raw.split(" ").map((part) => parseInt(part, 10));
        if (parts.length === 3 && parts.every((part) => Number.isFinite(part))) {
          const [ascent, descent] = parts as [number, number, number];
          if (ascent + descent > 0 && ascent + descent <= 255) {
            font = new TtfFont(path, sizePx, gamma, ascent, descent);
          }
        }
      } catch (error) {
        console.warn(`TtfFont.load failed for ${path}: ${error}`);
      }
    }
    loadedFonts.set(key, font);
    return font;
  }

  /**
   * The codepoint's glyph (rendered and memoized on first use), or undefined
   * when the render fails outright. Android renders SOMETHING for any
   * codepoint the face covers or tofu otherwise, so undefined is rare.
   * Ink-free glyphs (space) have bbxWidth 0 and no coverage.
   */
  getGlyph(codePoint: number): Glyph | undefined {
    let glyph = this.glyphCache.get(codePoint);
    if (glyph === undefined) {
      glyph = this.loadGlyph(codePoint);
      this.glyphCache.set(codePoint, glyph);
    }
    return glyph ?? undefined;
  }

  hasGlyph(codePoint: number): boolean {
    return this.getGlyph(codePoint) !== undefined;
  }

  /**
   * Pixel width of the widest line in `text` (fractional; kerning included),
   * for wrapping and truncation.
   */
  measureText(text: string): number {
    const cps = toCodePoints(text);
    let width = 0;
    let maxWidth = 0;
    for (let i = 0; i < cps.length; i++) {
      const cp = cps[i]!;
      if (cp === 10) {
        maxWidth = Math.max(maxWidth, width);
        width = 0;
        continue;
      }
      width += this.advanceOf(cp);
      const next = cps[i + 1];
      if (next !== undefined && next !== 10) {
        width += this.kernBetween(cp, next);
      }
    }
    return Math.max(maxWidth, width);
  }

  /**
   * Draw text with the font's own (fractional, kerned) layout, recording
   * each inked glyph as a deferred draw on the image. y is the top of the
   * line (baseline at y + ascent), matching GrayImage.drawText.
   */
  drawText(image: GrayImage, x: number, y: number, text: string, value: number): void {
    const cps = toCodePoints(text);
    let penX = x;
    let lineY = y;
    for (let i = 0; i < cps.length; i++) {
      const cp = cps[i]!;
      if (cp === 10) {
        penX = x;
        lineY += this.lineHeight;
        continue;
      }
      const glyph = this.getGlyph(cp);
      if (!glyph) continue;
      if (glyph.coverage && glyph.bbxWidth > 0) {
        image.drawGlyph(this, glyph, Math.round(penX), lineY, value);
      }
      penX += glyph.advance ?? glyph.dwidthX;
      const next = cps[i + 1];
      if (next !== undefined && next !== 10) {
        penX += this.kernBetween(cp, next);
      }
    }
  }

  private advanceOf(codePoint: number): number {
    const glyph = this.getGlyph(codePoint);
    return glyph ? (glyph.advance ?? glyph.dwidthX) : 0;
  }

  /**
   * Kerning between two adjacent codepoints: measure(ab) - a - b, memoized.
   * One native measurement per distinct pair per JS context.
   */
  private kernBetween(a: number, b: number): number {
    const key = a * 0x200000 + b;
    const cached = this.kernCache.get(key);
    if (cached !== undefined) return cached;
    let kern = 0;
    try {
      const pair = Number(
        fontRenderer.measureTextExact(
          this.path,
          String.fromCodePoint(a) + String.fromCodePoint(b),
          this.sizePx,
        ),
      );
      if (pair > 0) {
        kern = pair - this.advanceOf(a) - this.advanceOf(b);
        // A kern larger than the em size means the decomposition failed
        // (e.g. the pair shaped into something we can't represent).
        if (!Number.isFinite(kern) || Math.abs(kern) > this.sizePx) kern = 0;
      }
    } catch {
      kern = 0;
    }
    this.kernCache.set(key, kern);
    return kern;
  }

  /** Render + quantize one glyph via renderGlyphCell (see FontFileRenderer). */
  private loadGlyph(codePoint: number): Glyph | null {
    let bytes: Uint8Array;
    try {
      bytes = toUint8Array(
        fontRenderer.renderGlyphCell(this.path, this.sizePx, codePoint, this.gamma),
      );
    } catch (error) {
      console.warn(`renderGlyphCell failed for U+${codePoint.toString(16)}: ${error}`);
      return null;
    }
    if (bytes.length < 10) return null;
    const u16 = (offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8);
    const s16 = (offset: number) => {
      const value = u16(offset);
      return value & 0x8000 ? value - 0x10000 : value;
    };
    const advance = u16(0) / 64;
    const bearingX = s16(2);
    const inkTop = s16(4);
    const width = u16(6);
    const height = u16(8);
    const base: Glyph = {
      encoding: codePoint,
      dwidthX: Math.round(advance),
      bbxWidth: 0,
      bbxHeight: 0,
      bbxX: 0,
      bbxY: 0,
      bitmapRows: [],
      advance,
    };
    if (width <= 0 || height <= 0 || bytes.length < 10 + width * height) {
      return base; // ink-free (space) or malformed: advance-only
    }
    // Quantize 8-bit coverage to the 4bpp levels the composite packs to;
    // faint fringe (< 8) quantizes to 0 = transparent.
    const coverage = new Uint8Array(width * height);
    let hasInk = false;
    for (let i = 0; i < coverage.length; i++) {
      const nibble = grayToNibble(bytes[10 + i]!);
      coverage[i] = nibble;
      if (nibble !== 0) hasInk = true;
    }
    if (!hasInk) return base;
    return {
      ...base,
      bbxWidth: width,
      bbxHeight: height,
      bbxX: bearingX,
      bbxY: this.ascent - inkTop - height,
      coverage,
    };
  }
}

function toCodePoints(text: string): number[] {
  const cps: number[] = [];
  for (const char of text) {
    cps.push(char.codePointAt(0)!);
  }
  return cps;
}

function fnv32(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
