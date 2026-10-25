#!/usr/bin/env node
/**
 * Preprocess Even's extracted 20px firmware fonts into a single asset Faceclaw
 * bundles and renders (app/fonts/evenhub/evenhub-20.json).
 *
 * Source: reverse-engineered LVGL lv_font_fmt_txt glyph data under
 * g2/downloads/s200_embedded_fonts/{background_latin_20, background_greek_
 * cyrillic_20, shared_emoji_20}. The Chinese font is intentionally excluded
 * (we will substitute an OFL font for CJK later).
 *
 * Only glyph BITMAPS + boxes are taken from here; text SIZING/KERNING at
 * runtime comes from @evenrealities/pretext, whose advance tables these
 * bitmaps were cross-validated against. The three fonts are merged with the
 * EvenHub fallback priority (latin > greek/cyrillic > emoji); the first font
 * that owns a codepoint wins, matching pretext's chain.
 *
 * Bitmaps are 4bpp, high-nibble-first, row stride = floor(box_w/2)+1 (Even's
 * pipeline pads every row by a nibble). The UI fonts are effectively 1-bit
 * (nibbles are 0 or 0xF) but we keep 4bpp verbatim so any anti-aliasing
 * survives.
 *
 * Output JSON:
 *   { lineHeight, baseline, glyphs: { "<cp>": [boxW, boxH, ofsX, ofsY, off, len] },
 *     bitmapBase64 }
 * where off/len index the decoded bitmap blob. lineHeight/baseline come from
 * the latin font (the layout reference; pretext uses the same 27px height).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FONT_SRC = join(here, "../../downloads/s200_embedded_fonts");
const OUT = join(here, "../app/fonts/evenhub/evenhub-20.json");

// Priority order = EvenHub fallback chain (minus cn).
const FONTS = ["background_latin_20", "background_greek_cyrillic_20", "shared_emoji_20"];

function rowStride(boxW) {
  return Math.floor(boxW / 2) + 1;
}

const merged = new Map(); // codepoint -> {boxW,boxH,ofsX,ofsY,bytes:Uint8Array}

for (const font of FONTS) {
  const dir = join(FONT_SRC, font);
  const glyphs = JSON.parse(readFileSync(join(dir, "glyphs.json"), "utf8"));
  const bitmap = readFileSync(join(dir, "glyph_bitmap.bin"));
  for (const g of glyphs) {
    if (g.codepoint === undefined) continue; // reserved / unmapped glyph slots
    if (merged.has(g.codepoint)) continue; // earlier font in the chain wins
    const len = g.box_height > 0 && g.box_width > 0 ? rowStride(g.box_width) * g.box_height : 0;
    // Guard against the known slightly-truncated bitmap tails: pad short reads.
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bitmap[g.bitmap_index + i] ?? 0;
    merged.set(g.codepoint, {
      boxW: g.box_width,
      boxH: g.box_height,
      ofsX: g.offset_x,
      ofsY: g.offset_y,
      bytes,
    });
  }
}

// Layout metrics from the latin font (also what pretext uses: 27px line).
const latinFont = JSON.parse(readFileSync(join(FONT_SRC, "background_latin_20", "manifest.json"), "utf8"));
const lineHeight = latinFont.line_height; // 27
const baseline = lineHeight - latinFont.base_line; // 27 - 5 = 22 (px below line top)

// ---------------------------------------------------------------------------
// Symbol / fullwidth glyphs from the CJK flash font (s200_font.bin).
//
// The three embedded UI fonts above cover latin/greek/emoji only, so grid-
// graphics apps come out blank: snake draws its board from U+3000 (ideographic
// space), U+25A6/U+25C6 (pieces) and fullwidth forms; block/box-drawing bars
// use U+2500-259F. Those glyphs live only in the SourceHanSans CJK font on the
// separate flash partition. We pull just the non-Han SYMBOL ranges from it
// (not the 21k ideographs — those wait for the OFL substitute) so grid UIs
// render. pretext already returns 20px advances for these, so only the bitmaps
// were missing. Format per notes/font-formats.txt (LVGL lv_font_fmt_txt in the
// "ZZZZ" flash wrapper, memory-mapped at 0x80100000).
const CJK_FONT = join(here, "../../downloads/s200_font.bin");
const CJK_MMAP_BASE = 0x80100000;
// Non-Han symbol ranges grid/graphics apps rely on (inclusive).
const SYMBOL_RANGES = [
  [0x2000, 0x206f], // general punctuation (incl. various spaces/dashes)
  [0x2100, 0x214f], // letterlike symbols (℃ ℉ №, etc.)
  [0x2190, 0x21ff], // arrows
  [0x2200, 0x22ff], // mathematical operators
  [0x2500, 0x257f], // box drawing
  [0x2580, 0x259f], // block elements
  [0x25a0, 0x25ff], // geometric shapes (snake pieces)
  [0x2600, 0x26ff], // miscellaneous symbols
  [0x2700, 0x27bf], // dingbats
  [0x3000, 0x303f], // CJK symbols & punctuation (ideographic space)
  [0xff00, 0xffef], // halfwidth & fullwidth forms
];

function loadCjkSymbols(existing) {
  let added = 0;
  const cjk = readFileSync(CJK_FONT);
  const off = (ptr) => ptr - CJK_MMAP_BASE;
  const descPtr = cjk.readUInt32LE(0x34);
  const cjkLineHeight = cjk.readUInt16LE(0x38);
  const cjkBaseLine = cjk.readUInt16LE(0x3a);
  const cjkBaseline = cjkLineHeight - cjkBaseLine; // 25 - 6 = 19
  // Our single composite baseline differs, so shift ofsY to keep the glyph's
  // designed vertical placement when drawn against our baseline.
  const baselineShift = baseline - cjkBaseline;

  let d = off(descPtr);
  const glyphBitmapOff = off(cjk.readUInt32LE(d));
  const glyphDscOff = off(cjk.readUInt32LE(d + 4));
  const cmapOff = off(cjk.readUInt32LE(d + 8));
  // kerning ptr (d+12) is null; packed field after gives cmap_num.
  const packed = cjk.readUInt16LE(d + 18);
  const cmapNum = packed & 0x1ff;

  // Parse the cmap table into lookup records.
  const cmaps = [];
  for (let i = 0; i < cmapNum; i++) {
    const base = cmapOff + i * 20;
    cmaps.push({
      rangeStart: cjk.readUInt32LE(base),
      rangeLength: cjk.readUInt16LE(base + 4),
      glyphIdStart: cjk.readUInt16LE(base + 6),
      unicodeListPtr: cjk.readUInt32LE(base + 8),
      glyphIdOfsListPtr: cjk.readUInt32LE(base + 12),
      listLength: cjk.readUInt16LE(base + 16),
      type: cjk.readUInt8(base + 18),
    });
  }

  const glyphIdFor = (cp) => {
    for (const c of cmaps) {
      if (cp < c.rangeStart || cp >= c.rangeStart + c.rangeLength) continue;
      const rel = cp - c.rangeStart;
      if (c.type === 2) return c.glyphIdStart + rel; // contiguous
      if (c.type === 0) {
        // u8 glyph-id-offset array
        return c.glyphIdStart + cjk.readUInt8(off(c.glyphIdOfsListPtr) + rel);
      }
      if (c.type === 3) {
        // sparse: u16 unicode-delta list; index in the list is the glyph offset
        const listOff = off(c.unicodeListPtr);
        for (let k = 0; k < c.listLength; k++) {
          if (cjk.readUInt16LE(listOff + k * 2) === rel) {
            const gid = c.glyphIdOfsListPtr
              ? cjk.readUInt8(off(c.glyphIdOfsListPtr) + k)
              : k;
            return c.glyphIdStart + gid;
          }
        }
        return 0;
      }
    }
    return 0;
  };

  for (const [start, end] of SYMBOL_RANGES) {
    for (let cp = start; cp <= end; cp++) {
      if (existing.has(cp)) continue; // don't override latin/greek/emoji
      const gid = glyphIdFor(cp);
      if (!gid) continue;
      const dsc = glyphDscOff + gid * 16;
      const bitmapIndex = cjk.readUInt32LE(dsc);
      const boxW = cjk.readUInt16LE(dsc + 8);
      const boxH = cjk.readUInt16LE(dsc + 10);
      const ofsX = cjk.readInt16LE(dsc + 12);
      const ofsY = cjk.readInt16LE(dsc + 14);
      const len = boxW > 0 && boxH > 0 ? rowStride(boxW) * boxH : 0;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = cjk[glyphBitmapOff + bitmapIndex + i] ?? 0;
      existing.set(cp, { boxW, boxH, ofsX, ofsY: ofsY + baselineShift, bytes });
      added++;
    }
  }
  return added;
}

const cjkAdded = loadCjkSymbols(merged);

// Concatenate bitmaps and record offsets.
const chunks = [];
let offset = 0;
const glyphRecords = {};
for (const [cp, g] of [...merged].sort((a, b) => a[0] - b[0])) {
  chunks.push(g.bytes);
  glyphRecords[cp] = [g.boxW, g.boxH, g.ofsX, g.ofsY, offset, g.bytes.length];
  offset += g.bytes.length;
}
const blob = Buffer.concat(chunks.map((c) => Buffer.from(c)));

const asset = {
  lineHeight,
  baseline,
  glyphs: glyphRecords,
  bitmapBase64: blob.toString("base64"),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(asset));
console.log(
  `wrote ${OUT}: ${merged.size} glyphs (${cjkAdded} from CJK symbols), ` +
    `${blob.length} bitmap bytes, ${(JSON.stringify(asset).length / 1024).toFixed(1)} KiB json`,
);
