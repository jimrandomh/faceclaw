import { Glyph } from "./bdffont";
import { wrapText } from "./textwrap";

export const G2_LENS_WIDTH = 640;
export const G2_LENS_HEIGHT = 480;
const DEFAULT_CORNER_RADIUS = 8;

export function imageFromAsciiArt(lines: readonly string[], value = 255): GrayImage {
  const width = Math.max(0, ...lines.map((line) => line.length));
  const image = new GrayImage(width, lines.length, 0);
  const fill = clampByte(value);
  for (let y = 0; y < lines.length; y++) {
    const line = lines[y]!;
    for (let x = 0; x < line.length; x++) {
      const pixel = line[x];
      if (pixel && pixel !== " " && pixel !== ".") {
        image.pixels[y * width + x] = fill;
      }
    }
  }
  return image;
}

/**
 * The font behind a deferred glyph draw: what rasterizeGlyph and the wire
 * encoder (glyph-wire.ts) need from it. BdfFont satisfies this directly;
 * TtfFont (ttf-font.ts) implements it for antialiased glyphs. Structural so
 * image.ts needs no imports beyond BdfFont's Glyph shape.
 */
export interface GlyphFont {
  /** Process-local identity for content fingerprints (see BdfFont). */
  readonly fingerprintId: number;
  /** Stable cross-context identity for the on-glasses glyph atlas, or null. */
  readonly atlasKey: string | null;
  readonly ascent: number;
  readonly lineHeight: number;
}

/**
 * A general text-drawing font: what GrayImage.drawText and the shared list
 * UI helpers need. BdfFont (bitmap) and TtfFont (antialiased) both implement
 * it. The font owns text layout (drawText) because layout rules differ by
 * kind — BDF advances are integers, TTF advances are fractional and kerned.
 */
export interface UiFont extends GlyphFont {
  readonly descent: number;
  measureText(text: string): number;
  getGlyph(codePoint: number): Glyph | undefined;
  hasGlyph(codePoint: number): boolean;
  drawText(image: GrayImage, x: number, y: number, text: string, value: number): void;
}

/**
 * One deferred glyph draw. Text drawn through drawGlyph/drawText/
 * drawTextWrapped is retained here rather than baked into the pixel buffer,
 * so the compositor can ship glyphs as on-glasses cached draws instead of
 * pixels. (x, y) and value are the drawGlyph arguments (y is the top of
 * the line; the baseline is y + font.ascent).
 */
export type PlacedGlyph = {
  kind: "glyph";
  font: GlyphFont;
  glyph: Glyph;
  x: number;
  y: number;
  value: number;
};

/**
 * One deferred image draw (drawImage): a color-key blit of `source` at
 * (x, y), retained so icons can ship as on-glasses cached-image draws.
 * `source` is flat (no deferred draws of its own) and treated as immutable
 * from the moment it is placed.
 */
export type PlacedImage = {
  kind: "image";
  source: GrayImage;
  x: number;
  y: number;
};

/** One member of a firmware-font text run: codepoint at run.x + dx; ink =
 * whether it has visible pixels (spaces are inkless connectors kept for the
 * firmware's own advance/kerning continuity). */
export type PlacedFwTextGlyph = {
  cp: number;
  dx: number;
  ink: boolean;
};

/**
 * The provider behind firmware-font text runs (implemented by EvenHubFont).
 * Structural interface so image.ts needs no import: the font both bakes runs
 * phone-side (with firmware-exact pixel math) and serves per-glyph raster
 * data for the Java-side eligibility checks.
 */
export interface FwTextFont {
  /** Stable tag for fingerprints/registration (one builtin font today). */
  readonly atlasTag: number;
  bakeFwTextRun(target: GrayImage, run: PlacedFwText, dx: number, dy: number): void;
  /** Wire-registration raster for a run member, or null when unavailable. */
  fwGlyphWireData(cp: number): {
    ofsX: number;
    /** First ink row relative to the run's line-top y. */
    inkTop: number;
    boxW: number;
    boxH: number;
    /** 4bpp rows, stride ceil(boxW/2), high nibble = left pixel. */
    nibbles: Uint8Array;
  } | null;
}

/**
 * One deferred firmware-font text run (CFW mode 15): a maximal stretch of
 * text that EvenHubFont laid out with consecutive pretext advances, drawn by
 * the glasses' builtin 20px font chain. Members' dx are relative to x so
 * translation only touches x/y. Runs must only be built over glyphs whose
 * on-glasses rendering the phone predicts exactly (the font enforces this).
 */
export type PlacedFwText = {
  kind: "fwtext";
  font: FwTextFont;
  /** Pen x of the first member; the wire draw starts exactly here. */
  x: number;
  /** Line top y (the mode-15 y argument). */
  y: number;
  value: number;
  glyphs: readonly PlacedFwTextGlyph[];
};

/**
 * A retained draw, always rendered on top of the raster pixels regardless of
 * draw order (deferred draws keep their order among themselves). An overlay
 * that must cover deferred draws below it needs its own plane (see plane.ts)
 * or must suppress the covered draws.
 */
export type DeferredDraw = PlacedGlyph | PlacedImage | PlacedFwText;

export class GrayImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  private readonly drawList: DeferredDraw[] = [];
  /** See sourceContentHash32; null until this image is hashed as a draw source. */
  private memoizedSourceHash: number | null = null;

  constructor(width: number, height: number, fill = 0) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height);
    this.clear(fill);
  }

  get draws(): readonly DeferredDraw[] {
    return this.drawList;
  }

  hasDeferredDraws(): boolean {
    return this.drawList.length > 0;
  }

  clone(): GrayImage {
    const clone = new GrayImage(this.width, this.height, 0);
    clone.pixels.set(this.pixels);
    clone.drawList.push(...this.drawList);
    return clone;
  }

  clear(value = 0): void {
    this.pixels.fill(clampByte(value));
    this.drawList.length = 0;
  }

  setPixel(x: number, y: number, value: number): void {
    this.setPixelUnchecked(x, y, clampByte(value));
  }

  private setPixelUnchecked(x: number, y: number, value: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.pixels[y * this.width + x] = value;
  }

  getPixel(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.pixels[y * this.width + x] ?? 0;
  }

  fillRect(x: number, y: number, width: number, height: number, value: number): void {
    const left = Math.max(0, x | 0);
    const top = Math.max(0, y | 0);
    const right = Math.min(this.width, (x + width) | 0);
    const bottom = Math.min(this.height, (y + height) | 0);
    const fill = clampByte(value);
    for (let row = top; row < bottom; row++) {
      const offset = row * this.width;
      for (let col = left; col < right; col++) {
        this.pixels[offset + col] = fill;
      }
    }
  }

  drawRect(x: number, y: number, width: number, height: number, value: number): void {
    this.drawLine(x, y, x + width - 1, y, value);
    this.drawLine(x, y, x, y + height - 1, value);
    this.drawLine(x + width - 1, y, x + width - 1, y + height - 1, value);
    this.drawLine(x, y + height - 1, x + width - 1, y + height - 1, value);
  }

  drawLine(x0: number, y0: number, x1: number, y1: number, value: number): void {
    let ax = Math.round(x0);
    let ay = Math.round(y0);
    const bx = Math.round(x1);
    const by = Math.round(y1);
    const stroke = clampByte(value);
    const dx = Math.abs(bx - ax);
    const sx = ax < bx ? 1 : -1;
    const dy = -Math.abs(by - ay);
    const sy = ay < by ? 1 : -1;
    let err = dx + dy;

    while (true) {
      this.setPixelUnchecked(ax, ay, stroke);
      if (ax === bx && ay === by) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        ax += sx;
      }
      if (e2 <= dx) {
        err += dx;
        ay += sy;
      }
    }
  }

  drawText(font: UiFont, x: number, y: number, text: string, value: number): void {
    font.drawText(this, x, y, text, value);
  }

  drawTextWrapped({font, x, y, width, text, value }: {
    font: UiFont;
    x: number;
    y: number;
    width: number;
    text: string;
    value: number;
  }): void {
    const lines = wrapText(font, text, width);
    for (let i = 0; i < lines.length; i++) {
      font.drawText(this, x, y + i * font.lineHeight, lines[i]!, value);
    }
  }

  bitBlt(
    source: GrayImage,
    dx: number,
    dy: number,
    opts: {
      sx?: number;
      sy?: number;
      width?: number;
      height?: number;
      /** Skip source pixels with value 0 (color-key transparency). */
      transparentZero?: boolean;
    } = {},
  ): void {
    const srcX = Math.max(0, (opts.sx ?? 0) | 0);
    const srcY = Math.max(0, (opts.sy ?? 0) | 0);
    const copyWidth = Math.max(0, (opts.width ?? (source.width - srcX)) | 0);
    const copyHeight = Math.max(0, (opts.height ?? (source.height - srcY)) | 0);
    const destX = dx | 0;
    const destY = dy | 0;

    for (let row = 0; row < copyHeight; row++) {
      const sy = srcY + row;
      const ty = destY + row;
      if (sy < 0 || sy >= source.height || ty < 0 || ty >= this.height) continue;
      for (let col = 0; col < copyWidth; col++) {
        const sx = srcX + col;
        const tx = destX + col;
        if (sx < 0 || sx >= source.width || tx < 0 || tx >= this.width) continue;
        const value = source.pixels[sy * source.width + sx] ?? 0;
        if (opts.transparentZero && value === 0) continue;
        this.pixels[ty * this.width + tx] = value;
      }
    }

    // Carry the source's deferred draws along, translated into destination
    // space. Membership in the copied rect is judged by the draw's anchor
    // (fine for the whole-image blits this is used for; a sub-rect blit can
    // clip a draw's overhang imperfectly).
    if (source.drawList.length) {
      const offsetX = destX - srcX;
      const offsetY = destY - srcY;
      for (const placed of source.drawList) {
        if (
          placed.x >= srcX && placed.x < srcX + copyWidth &&
          placed.y >= srcY && placed.y < srcY + copyHeight
        ) {
          this.drawList.push({ ...placed, x: placed.x + offsetX, y: placed.y + offsetY });
        }
      }
    }
  }

  fillRoundedRect(
    x: number,
    y: number,
    width: number,
    height: number,
    value: number,
    radius = DEFAULT_CORNER_RADIUS,
  ): void {
    const left = x | 0;
    const top = y | 0;
    const rectWidth = width | 0;
    const rectHeight = height | 0;
    const bottom = top + rectHeight;
    const fill = clampByte(value);
    for (let row = top; row < bottom; row++) {
      if (row < 0 || row >= this.height) continue;
      const span = roundedRectRowSpan(row, left, top, rectWidth, rectHeight, radius);
      if (!span) continue;
      const start = Math.max(0, span.left);
      const end = Math.min(this.width, span.right);
      const offset = row * this.width;
      for (let col = start; col < end; col++) {
        this.pixels[offset + col] = fill;
      }
    }
  }

  drawRoundedRect(
    x: number,
    y: number,
    width: number,
    height: number,
    value: number,
    radius = DEFAULT_CORNER_RADIUS,
  ): void {
    const left = x | 0;
    const top = y | 0;
    const rectWidth = width | 0;
    const rectHeight = height | 0;
    const bottom = top + rectHeight;
    const stroke = clampByte(value);
    const innerLeft = left + 1;
    const innerTop = top + 1;
    const innerWidth = rectWidth - 2;
    const innerHeight = rectHeight - 2;

    for (let row = top; row < bottom; row++) {
      if (row < 0 || row >= this.height) continue;
      const outer = roundedRectRowSpan(row, left, top, rectWidth, rectHeight, radius);
      if (!outer) continue;
      const inner =
        innerWidth > 0 && innerHeight > 0
          ? roundedRectRowSpan(row, innerLeft, innerTop, innerWidth, innerHeight, Math.max(0, radius - 1))
          : undefined;
      const offset = row * this.width;
      const outerLeft = Math.max(0, outer.left);
      const outerRight = Math.min(this.width, outer.right);
      if (!inner) {
        for (let col = outerLeft; col < outerRight; col++) {
          this.pixels[offset + col] = stroke;
        }
        continue;
      }

      const innerLeftClamped = Math.max(outerLeft, Math.min(outerRight, inner.left));
      const innerRightClamped = Math.max(outerLeft, Math.min(outerRight, inner.right));
      for (let col = outerLeft; col < innerLeftClamped; col++) {
        this.pixels[offset + col] = stroke;
      }
      for (let col = innerRightClamped; col < outerRight; col++) {
        this.pixels[offset + col] = stroke;
      }
    }
  }

  /** 32-bit content hash over pixels and deferred draws (fingerprint's core). */
  contentHash32(): number {
    let hash = this.pixelsHash32();
    for (const placed of this.drawList) {
      if (placed.kind === "glyph") {
        hash = mixInt(hash, placed.font.fingerprintId);
        hash = mixInt(hash, placed.glyph.encoding);
        hash = mixInt(hash, placed.value);
      } else if (placed.kind === "image") {
        hash = mixInt(hash, 0x1c0e5);
        hash = mixInt(hash, placed.source.width);
        hash = mixInt(hash, placed.source.height);
        hash = mixInt(hash, placed.source.sourceContentHash32());
      } else {
        hash = mixInt(hash, 0xf17e);
        hash = mixInt(hash, placed.font.atlasTag);
        hash = mixInt(hash, placed.value);
        for (const member of placed.glyphs) {
          hash = mixInt(hash, member.cp);
          hash = mixInt(hash, member.dx);
        }
      }
      hash = mixInt(hash, placed.x);
      hash = mixInt(hash, placed.y);
    }
    return hash >>> 0;
  }

  /**
   * FNV-1a over the raster pixels. Four bytes at a time where alignment
   * allows: this runs on every frame's fingerprint, over the whole screen, on
   * the thread that is about to hand the frame to the transport.
   */
  private pixelsHash32(): number {
    const pixels = this.pixels;
    let hash = 2166136261;
    let i = 0;
    if ((pixels.byteOffset & 3) === 0) {
      const words = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.length >>> 2);
      for (let w = 0; w < words.length; w++) {
        hash ^= words[w]!;
        hash = Math.imul(hash, 16777619);
      }
      i = words.length << 2;
    }
    for (; i < pixels.length; i++) {
      hash ^= pixels[i]!;
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  /**
   * contentHash32 for an image being used as another image's deferred-draw
   * source, memoized. drawImage/drawFwText document their source as immutable
   * from the call onwards (glyph-wire's ImageAtlas id cache already depends on
   * that), so the hash of a long-lived icon asset can be computed once instead
   * of on every frame that draws it.
   */
  sourceContentHash32(): number {
    if (this.memoizedSourceHash === null) {
      this.memoizedSourceHash = this.contentHash32();
    }
    return this.memoizedSourceHash;
  }

  fingerprint(): string {
    return `fnv:${this.contentHash32().toString(16)}`;
  }

  /**
   * Snapshot of the full image as a single 8-bit-per-pixel grayscale buffer,
   * row-major and top-to-bottom, with any deferred draws baked in. The Java
   * side turns this into whatever wire format the firmware currently expects
   * (today: a 4bpp BMP), so all framing concerns stay on one side of the
   * bridge.
   */
  to8bppBuffer(): Uint8Array {
    if (!this.drawList.length) {
      // slice() is a memcpy; Uint8Array.from walks the buffer element by element.
      return this.pixels.slice();
    }
    // withDrawsBaked's buffer is a private temporary, safe to hand out.
    return this.withDrawsBaked().pixels;
  }

  /**
   * Record a glyph draw. Deferred: the glyph joins the image's draw list
   * (rendered above all raster pixels) instead of being baked into the
   * buffer.
   */
  drawGlyph(font: GlyphFont, glyph: Glyph, x: number, y: number, value: number): void {
    this.drawList.push({ kind: "glyph", font, glyph, x, y, value: clampByte(value) });
  }

  /**
   * Record a color-key image blit (source value 0 = transparent), deferred
   * like glyph draws so icons keep their identity to the wire encoder. The
   * source is snapshot-flattened (its own deferred draws baked) and must not
   * be mutated afterwards — pass long-lived rendered assets (icons), not
   * scratch buffers. For a clipped or mutable blit, use bitBlt instead.
   */
  drawImage(source: GrayImage, x: number, y: number): void {
    if (source.width <= 0 || source.height <= 0) return;
    this.drawList.push({ kind: "image", source: source.withDrawsBaked(), x, y });
  }

  /**
   * Record a firmware-font text run (see PlacedFwText). Called by
   * EvenHubFont, which owns run construction; the members array must be
   * immutable from here on.
   */
  drawFwText(
    font: FwTextFont,
    x: number,
    y: number,
    value: number,
    glyphs: readonly PlacedFwTextGlyph[],
  ): void {
    if (glyphs.length === 0) return;
    this.drawList.push({ kind: "fwtext", font, x, y, value: clampByte(value), glyphs });
  }

  /**
   * Bake this image's deferred draws into its own pixels and clear the list.
   * Used where later raster must be able to cover earlier draws within the
   * same image (e.g. the EvenHub compositor's image-over-text z-order).
   */
  bakeDeferredDrawsInPlace(): void {
    if (!this.drawList.length) return;
    const draws = this.drawList.splice(0, this.drawList.length);
    for (const placed of draws) {
      if (placed.kind === "glyph") {
        rasterizeGlyph(this, placed.font, placed.glyph, placed.x, placed.y, placed.value);
      } else if (placed.kind === "image") {
        this.bitBlt(placed.source, placed.x, placed.y, { transparentZero: true });
      } else {
        placed.font.bakeFwTextRun(this, placed, 0, 0);
      }
    }
  }

  /**
   * This image with its deferred draws rasterized into the pixel buffer.
   * Returns this image unchanged when there are none, otherwise a baked copy
   * with an empty draw list.
   */
  withDrawsBaked(): GrayImage {
    if (!this.drawList.length) return this;
    const baked = new GrayImage(this.width, this.height, 0);
    baked.pixels.set(this.pixels);
    this.bakeDrawsInto(baked, 0, 0);
    return baked;
  }

  /**
   * Place this image into target at (dx, dy): raster via bitBlt, deferred
   * draws carried over as deferred draws (translated), so firmware-text runs
   * and cached glyphs stay on their cheap wire paths instead of being baked
   * to raster. The composed-in draws render above target's earlier raster,
   * matching the usual draw-above-own-raster rule.
   */
  composeInto(target: GrayImage, dx: number, dy: number): void {
    target.bitBlt(this, dx, dy);
    for (const placed of this.drawList) {
      target.drawList.push({ ...placed, x: placed.x + dx, y: placed.y + dy });
    }
  }

  /** Rasterize this image's deferred draws into target, translated by (dx, dy). */
  bakeDrawsInto(target: GrayImage, dx: number, dy: number): void {
    for (const placed of this.drawList) {
      if (placed.kind === "glyph") {
        rasterizeGlyph(target, placed.font, placed.glyph, placed.x + dx, placed.y + dy, placed.value);
      } else if (placed.kind === "image") {
        target.bitBlt(placed.source, placed.x + dx, placed.y + dy, { transparentZero: true });
      } else {
        placed.font.bakeFwTextRun(target, placed, dx, dy);
      }
    }
  }
}

/**
 * The 4bpp level an 8-bit gray value packs to (BmpUtil's GRAY_TO_NIBBLE).
 * Shared by every phone-side bake that must match the firmware's draw-time
 * LUT math bit-for-bit (AA glyphs here, EvenHubFont's mode-15 bakes).
 */
export function grayToNibble(value: number): number {
  return value <= 0 ? 0 : Math.min(15, (value + 8) >> 4);
}

/** Bake one glyph into an image's pixel buffer (y is the top of the line). */
function rasterizeGlyph(
  target: GrayImage,
  font: GlyphFont,
  glyph: Glyph,
  x: number,
  y: number,
  value: number,
): void {
  const baselineY = y + font.ascent;
  const top = baselineY - (glyph.bbxHeight + glyph.bbxY);
  const left = x + glyph.bbxX;
  if (glyph.coverage) {
    // Firmware-exact AA shading (see EvenHubFont.drawGlyph): the CFW draws
    // cached glyphs through a LUT mapping source nibble n to n*top/15
    // (integer), skipping only n == 0. Writing 16*level makes the composite
    // quantize (grayToNibble) back to exactly that level, so the
    // texture-cache planner's pixel checks — and the shadow after an
    // on-glasses mode-14 draw — match this bake bit-for-bit.
    const top4 = grayToNibble(value);
    for (let row = 0; row < glyph.bbxHeight; row++) {
      const rowStart = row * glyph.bbxWidth;
      for (let col = 0; col < glyph.bbxWidth; col++) {
        const nibble = glyph.coverage[rowStart + col]!;
        if (nibble === 0) continue;
        target.setPixel(left + col, top + row, Math.floor((nibble * top4) / 15) * 16);
      }
    }
    return;
  }
  const rowBitWidth = ((glyph.bbxWidth + 7) >> 3) << 3;
  for (let row = 0; row < glyph.bbxHeight; row++) {
    const bits = glyph.bitmapRows[row] ?? 0;
    for (let col = 0; col < glyph.bbxWidth; col++) {
      const shift = rowBitWidth - 1 - col;
      if (((bits >> shift) & 1) !== 0) {
        target.setPixel(left + col, top + row, value);
      }
    }
  }
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** Fold a 32-bit int into an FNV-style running hash. */
function mixInt(hash: number, value: number): number {
  hash ^= value | 0;
  return Math.imul(hash, 16777619);
}

function roundedRectRowSpan(
  row: number,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): { left: number; right: number } | undefined {
  if (width <= 0 || height <= 0 || row < y || row >= y + height) return undefined;
  const r = Math.max(0, Math.min(radius | 0, (width / 2) | 0, (height / 2) | 0));
  if (r === 0) return { left: x, right: x + width };

  const cy = row + 0.5;
  const topCornerBottom = y + r;
  const bottomCornerTop = y + height - r;
  if (cy >= topCornerBottom && cy < bottomCornerTop) {
    return { left: x, right: x + width };
  }

  const cornerY = cy < topCornerBottom ? topCornerBottom : bottomCornerTop;
  const dy = cy - cornerY;
  const dxSquared = r * r - dy * dy;
  if (dxSquared < 0) return undefined;

  const inset = (r - Math.sqrt(dxSquared) + 0.5) | 0;
  return { left: x + inset, right: x + width - inset };
}
