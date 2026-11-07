/**
 * Font rasterization for the browser, on the main thread and in workers alike:
 * opentype.js for metrics, kerning and outlines, an OffscreenCanvas for
 * antialiased coverage. CSS fonts won't do: they load asynchronously, and this
 * API (like the Android and iOS renderers) answers synchronously, often while a
 * module is still evaluating.
 */
import { parse } from "opentype.js";
import { File } from "@nativescript/core";

/** The corner of opentype.js used here (the package ships no types). */
type Path = { getBoundingBox(): { x1: number; y1: number; x2: number; y2: number }; toPathData(decimalPlaces?: number): string };
type RenderOptions = { kerning?: boolean; features?: Record<string, boolean> };
type Font = {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  tables: Record<string, unknown>;
  names: Record<string, Record<string, string> | undefined>;
  getAdvanceWidth(text: string, fontSize: number, options?: RenderOptions): number;
  getPath(text: string, x: number, y: number, fontSize: number, options?: RenderOptions): Path;
};
const parseFont = parse as (buffer: ArrayBuffer) => Font;

const fonts = new Map<string, Font | null>();

function loadFont(path: string): Font | null {
  const cached = fonts.get(path);
  if (cached !== undefined) return cached;
  let font: Font | null = null;
  try {
    const bytes = File.fromPath(path).readSync();
    font = parseFont(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  } catch (error) {
    console.warn(`Could not load font ${path}: ${error}`);
  }
  fonts.set(path, font);
  return font;
}

/** Paint.getFontMetricsInt's rounding: ascent, descent and leading in whole pixels. */
function lineMetrics(font: Font, size: number): { ascent: number; descent: number; gap: number } {
  const scale = size / font.unitsPerEm;
  const hhea = (font.tables as any).hhea ?? {};
  return {
    ascent: Math.round((hhea.ascender ?? font.ascender) * scale),
    descent: Math.round(-(hhea.descender ?? font.descender) * scale),
    gap: Math.round((hhea.lineGap ?? 0) * scale),
  };
}

const NO_LIGATURES = { kerning: true, features: { liga: false, rlig: false } };

let surface: OffscreenCanvas | null = null;
let context: OffscreenCanvasRenderingContext2D | null = null;

function drawingContext(width: number, height: number): OffscreenCanvasRenderingContext2D {
  if (!surface || surface.width < width || surface.height < height) {
    surface = new OffscreenCanvas(Math.max(width, surface?.width ?? 0), Math.max(height, surface?.height ?? 0));
    context = surface.getContext("2d", { willReadFrequently: true })!;
  }
  context!.clearRect(0, 0, surface.width, surface.height);
  context!.fillStyle = "#fff";
  return context!;
}

function fillPath(ctx: OffscreenCanvasRenderingContext2D, path: Path): void {
  // oxlint-disable-next-line unicorn/no-array-fill-with-reference-type -- a canvas's fill, not an array's
  ctx.fill(new Path2D(path.toPathData(3)));
}

/** The alpha channel of a drawn area: antialiased coverage. */
function coverage(ctx: OffscreenCanvasRenderingContext2D, width: number, height: number): Uint8Array {
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3]!;
  return alpha;
}

const gammaTables = new Map<number, Uint8Array>();

function gammaTable(gamma: number): Uint8Array {
  let table = gammaTables.get(gamma);
  if (!table) {
    table = new Uint8Array(256);
    for (let i = 0; i < 256; i++) table[i] = Math.round(255 * Math.pow(i / 255, gamma));
    gammaTables.set(gamma, table);
  }
  return table;
}

function packImage(alpha: Uint8Array, stride: number, x: number, width: number, height: number, gamma: number): Uint8Array {
  const table = gammaTable(gamma);
  const out = new Uint8Array(4 + width * height);
  out[0] = width & 0xff; out[1] = width >> 8; out[2] = height & 0xff; out[3] = height >> 8;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) out[4 + row * width + col] = table[alpha[row * stride + x + col]!]!;
  }
  return out;
}

function canLoadFont(path: string): boolean {
  return loadFont(path) !== null;
}

function getFontName(path: string): string {
  const names = loadFont(path)?.names as any;
  if (!names) return "";
  const family = names.preferredFamily?.en ?? names.fontFamily?.en ?? "";
  const style = names.preferredSubfamily?.en ?? names.fontSubfamily?.en ?? "";
  return family ? `${family}\n${style}` : "";
}

function getFontMetrics(path: string, size: number): string {
  const font = loadFont(path);
  if (!font || size <= 0) return "";
  const metrics = lineMetrics(font, size);
  return `${metrics.ascent} ${metrics.descent} ${metrics.gap}`;
}

function measureTextExact(path: string, text: string, size: number): number {
  const font = loadFont(path);
  return font && size > 0 ? font.getAdvanceWidth(text, size, NO_LIGATURES) : 0;
}

/** See FontFileRenderer.renderGlyphCell for the packet. */
function renderGlyphCell(path: string, size: number, codePoint: number, gamma: number): Uint8Array {
  const font = loadFont(path);
  if (!font || size <= 0) return new Uint8Array();
  const text = String.fromCodePoint(codePoint);
  const advance = font.getAdvanceWidth(text, size, NO_LIGATURES);
  const advanceFixed = Math.max(0, Math.min(0xffff, Math.round(advance * 64)));
  const empty = () => {
    const packet = new Uint8Array(10);
    packet[0] = advanceFixed & 0xff; packet[1] = advanceFixed >> 8;
    return packet;
  };
  const glyphPath = font.getPath(text, 0, 0, size, NO_LIGATURES);
  const box = glyphPath.getBoundingBox();
  if (!(box.x2 > box.x1) || !(box.y2 > box.y1)) return empty();
  const pad = 2;
  const left = Math.floor(box.x1), top = Math.floor(box.y1);
  const width = Math.ceil(box.x2) - left + pad * 2, height = Math.ceil(box.y2) - top + pad * 2;
  if (width * height > 1_000_000) return new Uint8Array();
  const penX = pad - left, baselineY = pad - top;
  const ctx = drawingContext(width, height);
  fillPath(ctx, font.getPath(text, penX, baselineY, size, NO_LIGATURES));
  const alpha = coverage(ctx, width, height);

  let inkLeft = width, inkRight = -1, inkTop = height, inkBottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] === 0) continue;
      if (x < inkLeft) inkLeft = x;
      if (x > inkRight) inkRight = x;
      if (y < inkTop) inkTop = y;
      if (y > inkBottom) inkBottom = y;
    }
  }
  if (inkRight < 0) return empty();
  const inkWidth = inkRight - inkLeft + 1, inkHeight = inkBottom - inkTop + 1;
  const ascent = lineMetrics(font, size).ascent;
  const packet = new Uint8Array(10 + inkWidth * inkHeight);
  const view = new DataView(packet.buffer);
  view.setUint16(0, advanceFixed, true);
  view.setInt16(2, inkLeft - penX, true);
  view.setInt16(4, inkTop - baselineY + ascent, true);
  view.setUint16(6, inkWidth, true);
  view.setUint16(8, inkHeight, true);
  const table = gammaTable(gamma);
  for (let row = 0; row < inkHeight; row++) {
    for (let col = 0; col < inkWidth; col++) {
      packet[10 + row * inkWidth + col] = table[alpha[(inkTop + row) * width + inkLeft + col]!]!;
    }
  }
  return packet;
}

function renderText(path: string, text: string, size: number, gamma: number): Uint8Array {
  const font = loadFont(path);
  if (!font || size <= 0 || !text) return new Uint8Array();
  const { ascent, descent } = lineMetrics(font, size);
  const pad = Math.ceil(size / 2);
  const advance = Math.ceil(font.getAdvanceWidth(text, size, NO_LIGATURES));
  const width = advance + pad * 2, height = ascent + descent;
  if (width <= 0 || height <= 0 || width * height > 4_000_000) return new Uint8Array();
  const ctx = drawingContext(width, height);
  fillPath(ctx, font.getPath(text, pad, ascent, size, NO_LIGATURES));
  const alpha = coverage(ctx, width, height);
  let left = pad, right = pad + advance;
  for (let x = 0; x < width; x++) {
    let inked = false;
    for (let y = 0; y < height && !inked; y++) inked = alpha[y * width + x] !== 0;
    if (inked) { left = Math.min(left, x); right = Math.max(right, x + 1); }
  }
  return packImage(alpha, width, left, Math.max(1, right - left), height, gamma);
}

/** Greedy word wrap, breaking inside words too long for a line, ellipsized past maxLines. */
function renderWrapped(path: string, text: string, size: number, maxWidth: number, gamma: number, maxLines: number): Uint8Array {
  const font = loadFont(path);
  if (!font || size <= 0 || maxWidth <= 0 || maxLines <= 0) return new Uint8Array();
  const measure = (value: string) => font.getAdvanceWidth(value, size, NO_LIGATURES);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/(?<=\s)/)) {
      if (measure(line + word.trimEnd()) <= maxWidth) { line += word; continue; }
      if (line) { lines.push(line.trimEnd()); line = ""; }
      let rest = word;
      while (measure(rest.trimEnd()) > maxWidth && rest.length > 1) {
        let fit = 1;
        while (fit < rest.length && measure(rest.slice(0, fit + 1)) <= maxWidth) fit++;
        lines.push(rest.slice(0, fit));
        rest = rest.slice(fit);
      }
      line = rest;
    }
    lines.push(line.trimEnd());
  }
  if (lines.length > maxLines) {
    let last = lines[maxLines - 1]!;
    while (last && measure(`${last}…`) > maxWidth) last = last.slice(0, -1);
    lines.length = maxLines;
    lines[maxLines - 1] = `${last.trimEnd()}…`;
  }
  const { ascent, descent, gap } = lineMetrics(font, size);
  const lineHeight = ascent + descent + gap;
  const height = Math.max(1, lines.length * lineHeight);
  if (maxWidth * height > 4_000_000) return new Uint8Array();
  const ctx = drawingContext(maxWidth, height);
  lines.forEach((line, index) => fillPath(ctx, font.getPath(line, 0, ascent + index * lineHeight, size, NO_LIGATURES)));
  return packImage(coverage(ctx, maxWidth, height), maxWidth, 0, maxWidth, height, gamma);
}

export const fontRenderer = { canLoadFont, getFontName, getFontMetrics, measureTextExact, renderGlyphCell, renderText, renderWrapped };
