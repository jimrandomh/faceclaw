import { BdfFont, Glyph } from "./bdffont";

export const G2_LENS_WIDTH = 576;
export const G2_LENS_HEIGHT = 288;
export const G2_TILE_WIDTH = 288;
export const G2_TILE_HEIGHT = 144;
const DEFAULT_CORNER_RADIUS = 8;

export type ImageTile = {
  x: number;
  y: number;
  width: number;
  height: number;
  bmp: Uint8Array;
};

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

export class GrayImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;

  constructor(width: number, height: number, fill = 0) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height);
    this.clear(fill);
  }

  clear(value = 0): void {
    this.pixels.fill(clampByte(value));
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

  drawText(font: BdfFont, x: number, y: number, text: string, value: number): void {
    let cursorX = x;
    const fill = clampByte(value);
    for (const char of text) {
      if (char === "\n") {
        cursorX = x;
        y += font.lineHeight;
        continue;
      }
      const glyph = font.getGlyph(char.codePointAt(0) ?? 32);
      if (!glyph) continue;
      this.drawGlyph(font, glyph, cursorX, y, fill);
      cursorX += glyph.dwidthX;
    }
  }

  bitBlt(
    source: GrayImage,
    dx: number,
    dy: number,
    opts: { sx?: number; sy?: number; width?: number; height?: number } = {},
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
        this.pixels[ty * this.width + tx] = source.pixels[sy * source.width + sx] ?? 0;
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

  fingerprint(): string {
    let hash = 2166136261;
    for (let i = 0; i < this.pixels.length; i++) {
      hash ^= this.pixels[i]!;
      hash = Math.imul(hash, 16777619);
    }
    return `fnv:${(hash >>> 0).toString(16)}`;
  }

  toEvenHubTiles(): ImageTile[] {
    const tiles: ImageTile[] = [];
    for (let ty = 0; ty < this.height; ty += G2_TILE_HEIGHT) {
      for (let tx = 0; tx < this.width; tx += G2_TILE_WIDTH) {
        const width = Math.min(G2_TILE_WIDTH, this.width - tx);
        const height = Math.min(G2_TILE_HEIGHT, this.height - ty);
        tiles.push({
          x: tx,
          y: ty,
          width,
          height,
          bmp: buildEvenHubBmp(width, height, (x, y) => this.getPixel(tx + x, ty + y) >> 4),
        });
      }
    }
    return tiles;
  }

  private drawGlyph(font: BdfFont, glyph: Glyph, x: number, y: number, value: number): void {
    const baselineY = y + font.ascent;
    const top = baselineY - (glyph.bbxHeight + glyph.bbxY);
    const left = x + glyph.bbxX;
    const rowBitWidth = ((glyph.bbxWidth + 7) >> 3) << 3;
    for (let row = 0; row < glyph.bbxHeight; row++) {
      const bits = glyph.bitmapRows[row] ?? 0;
      for (let col = 0; col < glyph.bbxWidth; col++) {
        const shift = rowBitWidth - 1 - col;
        if (((bits >> shift) & 1) !== 0) {
          this.setPixelUnchecked(left + col, top + row, value);
        }
      }
    }
  }
}

function buildEvenHubBmp(
  width: number,
  height: number,
  pixel: (x: number, y: number) => number,
): Uint8Array {
  const bytesPerPixelRow = (width + 1) >> 1;
  const rowStride = (bytesPerPixelRow + 3) & ~3;
  const pixelDataSize = rowStride * height;

  const fileHeaderSize = 14;
  const dibHeaderSize = 40;
  const paletteSize = 16 * 4;
  const pixelOffset = fileHeaderSize + dibHeaderSize + paletteSize;
  const fileSize = pixelOffset + pixelDataSize;

  const buf = new Uint8Array(fileSize);
  const view = new DataView(buf.buffer);
  buf[0] = 0x42;
  buf[1] = 0x4d;
  view.setUint32(2, fileSize, true);
  view.setUint32(10, pixelOffset, true);
  view.setUint32(14, dibHeaderSize, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 4, true);
  view.setUint32(30, 0, true);
  view.setUint32(34, pixelDataSize, true);
  view.setUint32(46, 16, true);

  for (let i = 0; i < 16; i++) {
    const v = i * 17;
    const base = fileHeaderSize + dibHeaderSize + i * 4;
    buf[base + 0] = v;
    buf[base + 1] = v;
    buf[base + 2] = v;
    buf[base + 3] = 0;
  }

  for (let bmpRow = 0; bmpRow < height; bmpRow++) {
    const srcY = height - 1 - bmpRow;
    const rowOffset = pixelOffset + bmpRow * rowStride;
    for (let x = 0; x < width; x += 2) {
      const hi = pixel(x, srcY) & 0x0f;
      const lo = (x + 1 < width ? pixel(x + 1, srcY) : 0) & 0x0f;
      buf[rowOffset + (x >> 1)] = (hi << 4) | lo;
    }
  }

  return buf;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
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
