/**
 * Even's on-glasses 20px UI font, for the EvenHub compatibility layer.
 *
 * Three pieces:
 *  - Latin + Greek/Cyrillic + emoji glyphs are extracted from the stock G2
 *    firmware into app-private storage while Faceclaw prepares custom firmware.
 *    They are not distributed with Faceclaw.
 *  - The final fallback is the G2's serialized Source Han Sans SC Light font,
 *    which Faceclaw can bundle under the SIL Open Font License. It carries no
 *    ASCII (it starts at U+00A4), so while the extracted fonts are missing a
 *    bundled Roboto backstops Latin text (see TTF_FALLBACK_ASSET_PATH).
 *  - Text SIZING / KERNING / WRAPPING: @evenrealities/pretext, whose advance
 *    tables the bitmaps were validated against. Using pretext for measurement
 *    means our line breaks match exactly where EvenHub apps (which measure
 *    with the same library) expect them.
 *
 * Bitmaps are 4bpp, high-nibble-first, row stride floor(boxW/2)+1. The UI
 * fonts are effectively 1-bit (nibbles 0 or 0xF); we keep the nibble value so
 * any anti-aliasing survives. Codepoints with no glyph are skipped silently,
 * matching stock firmware (no tofu boxes).
 */
import { File, knownFolders } from "@nativescript/core";
import { getTextWidth } from "@evenrealities/pretext";
import { EVENHUB_RUNTIME_FONT_FILENAME, isEvenHubFontAsset } from "../g2/firmware-fonts";
import { toUint8Array } from "../util/array-util";
import { GrayImage, grayToNibble, type FwTextFont, type PlacedFwText, type PlacedFwTextGlyph } from "./image";
import { TtfFont } from "./ttf-font";

declare const com: any;

const CJK_ASSET_PATH = "fonts/source-han-sans/SourceHanSansSC-Light-20.lvgl.bin";

/**
 * Last-resort face used ONLY while the extracted firmware fonts are missing.
 * The bundled CJK partition font starts at U+00A4 with no ASCII at all (on
 * stock it sits behind the main firmware's Latin fonts), so without this an
 * un-extracted install renders Latin text as nothing. Advances still come
 * from pretext, so layout and wrapping are unchanged; only the ink is
 * Roboto's. Once the real fonts are extracted this path is disabled and
 * unknown codepoints go back to stock's silent skip.
 */
const TTF_FALLBACK_ASSET_PATH = "fonts/ttf/Roboto-Regular.ttf";
const TTF_FALLBACK_SIZE_PX = 20;

/** [boxW, boxH, ofsX, ofsY, bitmapOffset, bitmapLen] */
type GlyphRecord = [number, number, number, number, number, number];

type FontAsset = {
  lineHeight: number;
  baseline: number;
  glyphs: Record<string, GlyphRecord>;
  bitmapBase64: string;
};

type CjkGlyph = {
  record: GlyphRecord;
  bitmap: Uint8Array;
};

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Decode(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let bitCount = 0;
  let outIndex = 0;
  for (let i = 0; i < clean.length; i++) {
    bits = (bits << 6) | BASE64_ALPHABET.indexOf(clean[i]!);
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      out[outIndex++] = (bits >> bitCount) & 0xff;
    }
  }
  return out.subarray(0, outIndex);
}

/**
 * Codepoint ranges whose glyphs the font asset merged from the flash CJK
 * font with a baseline-shifted ofsY (see scripts/build-evenhub-font.mjs).
 * The shift keeps the phone-side composite right, but the firmware's mode-15
 * draw uses the root font's baseline with the glyph's TRUE ofsY, so the two
 * may disagree by the shift — keep these baked until the fallback placement
 * is hardware-verified. Mirrors the build script's SYMBOL_RANGES.
 */
const MODE15_UNCERTAIN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x2000, 0x206f], [0x2100, 0x214f], [0x2190, 0x21ff], [0x2200, 0x22ff],
  [0x2500, 0x257f], [0x2580, 0x259f], [0x25a0, 0x25ff], [0x2600, 0x26ff],
  [0x2700, 0x27bf], [0x3000, 0x303f], [0xff00, 0xffef],
];

function inMode15UncertainRange(cp: number): boolean {
  for (const [start, end] of MODE15_UNCERTAIN_RANGES) {
    if (cp >= start && cp <= end) return true;
  }
  return false;
}

/** The 4bpp level an 8-bit value packs to (BmpUtil's GRAY_TO_NIBBLE). */
const quantNibble = grayToNibble;

export class EvenHubFont implements FwTextFont {
  /** One builtin firmware font today; see FwTextFont. */
  readonly atlasTag = 1;
  readonly lineHeight: number;
  readonly baseline: number;
  private readonly glyphs: Map<number, GlyphRecord>;
  private readonly bitmap: Uint8Array;
  private readonly cjkPath: string;
  private readonly cjkBaseline: number;
  private readonly cjkGlyphs = new Map<number, CjkGlyph | null>();
  /** Degraded mode: the extracted asset was missing, so Roboto backstops. */
  private readonly useTtfFallback: boolean;
  private ttfFallback: TtfFont | null | undefined;

  private constructor(asset: FontAsset, useTtfFallback = false) {
    this.useTtfFallback = useTtfFallback;
    this.lineHeight = asset.lineHeight;
    this.baseline = asset.baseline;
    this.bitmap = base64Decode(asset.bitmapBase64);
    this.glyphs = new Map();
    for (const key of Object.keys(asset.glyphs)) {
      this.glyphs.set(Number(key), asset.glyphs[key]!);
    }
    this.cjkPath = knownFolders.currentApp().getFile(CJK_ASSET_PATH).path;
    const metrics = toUint8Array(com.faceclaw.app.LvglFontFile.getMetrics(this.cjkPath));
    if (metrics.length < 2) {
      throw new Error("The bundled Source Han Sans font could not be loaded.");
    }
    this.cjkBaseline = metrics[1]!;
  }

  private static cached: EvenHubFont | null = null;

  static get(): EvenHubFont {
    if (!EvenHubFont.cached) {
      const path = `${knownFolders.documents().path}/${EVENHUB_RUNTIME_FONT_FILENAME}`;
      let asset: FontAsset | null = null;
      if (File.exists(path)) {
        try {
          const parsed: unknown = JSON.parse(File.fromPath(path).readTextSync());
          if (!isEvenHubFontAsset(parsed)) throw new Error("invalid font asset structure");
          asset = parsed;
        } catch (error) {
          console.warn(`Could not load the extracted G2 fonts; using fallback faces: ${error}`);
        }
      } else {
        console.warn(
          "The G2 fonts have not been extracted yet; using fallback faces. " +
            "The home screen's warning flag offers to prepare them.",
        );
      }
      EvenHubFont.cached = new EvenHubFont(
        asset ?? { lineHeight: 27, baseline: 22, glyphs: {}, bitmapBase64: "" },
        asset === null,
      );
    }
    return EvenHubFont.cached;
  }

  /**
   * Drop the cached instance so the next get() re-reads the extracted asset.
   * Called after a successful firmware-font extraction: without this, a
   * degraded instance built before the extraction would keep rendering with
   * the fallback faces until the app restarts.
   */
  static invalidate(): void {
    EvenHubFont.cached = null;
  }

  hasGlyph(codePoint: number): boolean {
    return this.glyphs.has(codePoint) || this.getCjkGlyph(codePoint) !== null;
  }

  /**
   * Pixel advance of a codepoint, including kerning against the following one
   * (pass 0/undefined for the last glyph). Derived from pretext's public
   * getTextWidth so it carries pretext's kerning and missing-glyph placeholder
   * exactly: width(a+b) - width(b) isolates a's kerned advance.
   */
  advanceOf(codePoint: number, nextCodePoint = 0): number {
    const a = String.fromCodePoint(codePoint);
    if (!nextCodePoint) return getTextWidth(a);
    const b = String.fromCodePoint(nextCodePoint);
    return getTextWidth(a + b) - getTextWidth(b);
  }

  /** Single-line pixel width including kerning (pretext-exact). */
  measureLine(text: string): number {
    return getTextWidth(text);
  }

  /**
   * Wrap text to a pixel width, returning the actual line strings. Ports
   * pretext's measureTextWrap (LVGL lv_text_get_next_line semantics) so the
   * breaks land exactly where the measurement library reports them.
   */
  wrap(text: string, maxWidth: number): string[] {
    if (!text) return [""];
    const cps = Array.from(text).map((c) => c.codePointAt(0)!);
    const lines: string[] = [];
    let line: number[] = [];
    let lineWidth = 0;
    let lastBreak = -1; // index within `line` after which we may wrap

    for (let i = 0; i < cps.length; i++) {
      const cp = cps[i]!;
      if (cp === 10) {
        lines.push(String.fromCodePoint(...line));
        line = [];
        lineWidth = 0;
        lastBreak = -1;
        continue;
      }
      // LVGL drops leading spaces at the start of a wrapped line.
      if (line.length === 0 && cp === 32) continue;
      const adv = this.advanceOf(cp, cps[i + 1] ?? 0);
      if (lineWidth + adv > maxWidth) {
        if (cp === 32) {
          // The overflowing char is a space: break here, discard it.
          lines.push(String.fromCodePoint(...line));
          line = [];
          lineWidth = 0;
          lastBreak = -1;
        } else if (lastBreak !== -1) {
          // Wrap at the last break opportunity; carry the remainder forward.
          const carry = line.slice(lastBreak + 1);
          line = line.slice(0, lastBreak + 1);
          const trimmed = line[line.length - 1] === 32 ? line.slice(0, -1) : line;
          lines.push(String.fromCodePoint(...trimmed));
          line = carry;
          lineWidth = carry.reduce((sum, c, j) => sum + this.advanceOf(c, carry[j + 1] ?? 0), 0);
          lastBreak = -1;
          line.push(cp);
          lineWidth += adv;
        } else {
          // No break opportunity: hard break before the overflowing char.
          lines.push(String.fromCodePoint(...line));
          line = [cp];
          lineWidth = adv;
          lastBreak = -1;
        }
      } else {
        line.push(cp);
        lineWidth += adv;
        if (isBreakable(cp)) lastBreak = line.length - 1;
      }
    }
    lines.push(String.fromCodePoint(...line));
    return lines;
  }

  /**
   * Draw one line of text with its top-left at (x, y). Missing glyphs are
   * skipped.
   *
   * Glyphs the firmware's mode-15 builtin-font draw renders identically to
   * our raster (native-table entries outside MODE15_UNCERTAIN_RANGES) are
   * recorded as deferred firmware-text runs: maximal stretches laid out with
   * consecutive pretext advances, spaces included as inkless connectors so
   * the firmware's own advance/kerning walk stays in lockstep. Anything else
   * (CJK fallback, shifted symbols, unknown codepoints) rasters immediately
   * and breaks the run — a break means the next run restarts at an explicit
   * pen x, so no cursor prediction ever spans an uncertain glyph.
   */
  drawText(image: GrayImage, x: number, y: number, text: string, value = 255): void {
    const cps = Array.from(text).map((c) => c.codePointAt(0)!);
    const baselineY = y + this.baseline;
    let penX = x;
    let run: PlacedFwTextGlyph[] = [];
    let runX = 0;
    const flushRun = () => {
      if (run.length) {
        this.emitRun(image, runX, y, value, run);
        run = [];
      }
    };
    for (let i = 0; i < cps.length; i++) {
      const cp = cps[i]!;
      const glyph = this.glyphs.get(cp);
      if (glyph && !inMode15UncertainRange(cp)) {
        if (run.length === 0) runX = penX;
        run.push({
          cp,
          dx: penX - runX,
          ink: glyph[0] > 0 && glyph[1] > 0 && glyph[5] > 0,
        });
      } else if (glyph) {
        flushRun();
        this.drawGlyph(image, glyph, this.bitmap, penX, baselineY, value);
      } else {
        flushRun();
        const cjk = this.getCjkGlyph(cp);
        if (cjk) {
          this.drawGlyph(image, cjk.record, cjk.bitmap, penX, y + this.cjkBaseline, value);
        } else if (this.useTtfFallback) {
          this.drawTtfFallbackGlyph(image, cp, penX, baselineY, value);
        }
      }
      penX += this.advanceOf(cp, cps[i + 1] ?? 0);
    }
    flushRun();
  }

  /** Record one run, trimmed of inkless leading/trailing connectors. */
  private emitRun(
    image: GrayImage,
    runX: number,
    lineY: number,
    value: number,
    members: PlacedFwTextGlyph[],
  ): void {
    let first = 0;
    let last = members.length - 1;
    while (first <= last && !members[first]!.ink) first++;
    while (last >= first && !members[last]!.ink) last--;
    if (first > last) return; // nothing visible
    const startX = runX + members[first]!.dx;
    const trimmed = members.slice(first, last + 1).map((member) =>
      first === 0 ? member : { ...member, dx: member.dx - members[first]!.dx },
    );
    image.drawFwText(this, startX, lineY, value, trimmed);
  }

  /** FwTextFont: bake a recorded run with firmware-exact pixel math. */
  bakeFwTextRun(target: GrayImage, run: PlacedFwText, dx: number, dy: number): void {
    const baselineY = run.y + dy + this.baseline;
    for (const member of run.glyphs) {
      if (!member.ink) continue;
      const glyph = this.glyphs.get(member.cp);
      if (glyph) this.drawGlyph(target, glyph, this.bitmap, run.x + member.dx + dx, baselineY, run.value);
    }
  }

  /** FwTextFont: raster registration data for the Java-side planner. */
  fwGlyphWireData(cp: number): {
    ofsX: number;
    inkTop: number;
    boxW: number;
    boxH: number;
    nibbles: Uint8Array;
  } | null {
    const glyph = this.glyphs.get(cp);
    if (!glyph) return null;
    const [boxW, boxH, ofsX, ofsY, off, len] = glyph;
    if (boxW <= 0 || boxH <= 0 || len <= 0 || boxW > 255 || boxH > 255) return null;
    if (ofsX < -32768 || ofsX > 32767) return null;
    const inkTop = this.baseline - boxH - ofsY;
    if (inkTop < -32768 || inkTop > 32767) return null;
    // Repack from the source stride (floor(boxW/2)+1, pad nibble at odd
    // widths) to the wire stride ceil(boxW/2).
    const srcStride = Math.floor(boxW / 2) + 1;
    const outStride = (boxW + 1) >> 1;
    const nibbles = new Uint8Array(outStride * boxH);
    for (let row = 0; row < boxH; row++) {
      for (let byte = 0; byte < outStride; byte++) {
        nibbles[row * outStride + byte] = this.bitmap[off + row * srcStride + byte] ?? 0;
      }
    }
    return { ofsX, inkTop, boxW, boxH, nibbles };
  }

  /** Draw wrapped text within a box; returns the number of lines drawn. */
  drawTextWrapped(image: GrayImage, x: number, y: number, maxWidth: number, text: string, value = 255): number {
    const lines = this.wrap(text, maxWidth);
    for (let i = 0; i < lines.length; i++) {
      this.drawText(image, x, y + i * this.lineHeight, lines[i]!, value);
    }
    return lines.length;
  }

  /** Degraded-mode ink: the codepoint's Roboto glyph, aligned on our baseline. */
  private drawTtfFallbackGlyph(image: GrayImage, cp: number, penX: number, baselineY: number, value: number): void {
    if (this.ttfFallback === undefined) {
      this.ttfFallback = TtfFont.load(
        knownFolders.currentApp().getFile(TTF_FALLBACK_ASSET_PATH).path,
        TTF_FALLBACK_SIZE_PX,
      );
    }
    const font = this.ttfFallback;
    const glyph = font?.getGlyph(cp);
    if (!font || !glyph || !glyph.coverage || glyph.bbxWidth <= 0) return;
    // drawGlyph's y is the TTF line top (baseline at y + ascent).
    image.drawGlyph(font, glyph, penX, baselineY - font.ascent, value);
  }

  private getCjkGlyph(codePoint: number): CjkGlyph | null {
    const cached = this.cjkGlyphs.get(codePoint);
    if (cached !== undefined) return cached;
    const bytes = toUint8Array(com.faceclaw.app.LvglFontFile.getGlyph(this.cjkPath, codePoint));
    if (bytes.length < 8) {
      this.cjkGlyphs.set(codePoint, null);
      return null;
    }
    const u16 = (offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8);
    const i16 = (offset: number) => {
      const value = u16(offset);
      return value & 0x8000 ? value - 0x10000 : value;
    };
    const bitmap = bytes.subarray(8);
    const glyph: CjkGlyph = {
      record: [u16(0), u16(2), i16(4), i16(6), 0, bitmap.length],
      bitmap,
    };
    this.cjkGlyphs.set(codePoint, glyph);
    return glyph;
  }

  private drawGlyph(
    image: GrayImage,
    glyph: GlyphRecord,
    bitmap: Uint8Array,
    penX: number,
    baselineY: number,
    value: number,
  ): void {
    const [boxW, boxH, ofsX, ofsY, off, len] = glyph;
    if (boxW <= 0 || boxH <= 0 || len <= 0) return;
    const stride = Math.floor(boxW / 2) + 1;
    const left = penX + ofsX;
    const top = baselineY - boxH - ofsY;
    // Firmware-exact shading: the CFW draws through a LUT mapping source
    // nibble n to n*top/15 (integer), skipping only n == 0. Writing 16*level
    // makes the composite quantize (min(15, (v+8)>>4)) back to exactly that
    // level, so the texture-cache planner's pixel checks — and the shadow
    // after an on-glasses mode-15 draw — match this bake bit-for-bit.
    const top4 = quantNibble(value);
    for (let row = 0; row < boxH; row++) {
      const rowStart = off + row * stride;
      for (let col = 0; col < boxW; col++) {
        const byte = bitmap[rowStart + (col >> 1)] ?? 0;
        const nibble = col % 2 === 0 ? byte >> 4 : byte & 0x0f;
        if (nibble === 0) continue;
        image.setPixel(left + col, top + row, Math.floor((nibble * top4) / 15) * 16);
      }
    }
  }
}

function isBreakable(cp: number): boolean {
  if (cp === 32 || cp === 45) return true; // space, hyphen
  // CJK ranges (pretext parity) — breakable between any two ideographs.
  return (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xac00 && cp <= 0xd7af);
}
