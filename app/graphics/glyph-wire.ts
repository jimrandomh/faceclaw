/**
 * Marshals deferred-draw identity (text glyphs and icon images) to the Java
 * side for the texture-cache pipeline (CFW modes 12/13/14; see
 * notes/texture-cache-display-list-design.md).
 *
 * Channels, all cheap ByteBuffer crossings:
 *  - glyph raster registration into the process-wide Java GlyphAtlas, once
 *    per (font, glyph) per JS context (main thread and each worker register
 *    independently; the atlas dedupes by the font's stable atlasKey);
 *  - image registration into the Java ImageAtlas, once per distinct image
 *    content per JS context (images are content-addressed: the key is a hash
 *    of dimensions + pixels, so the same icon rendered anywhere dedupes and
 *    a changed icon is simply a new image);
 *  - a per-frame draw list accompanying each submitted surface frame, which
 *    the Java planner may replay as on-glasses cached draws.
 *
 * Draws that can't participate (no atlasKey, outside the mode-14 ASCII
 * table, ink outside the line cell, oversized images) are simply left out —
 * their pixels are baked into the submitted frame either way, so exclusion
 * only means "no wire savings for this draw".
 */
import { Glyph } from "./bdffont";
import { GrayImage, type DeferredDraw, type GlyphFont, type PlacedFwText, type PlacedImage } from "./image";

declare const com: any;

const GLYPH_RECORD_BYTES = 12;   // [0][fontId u16][encoding u32][penX s16][lineY s16][value u8]
const IMAGE_RECORD_BYTES = 9;    // [1][imageId u32][x s16][y s16]
const FWTEXT_HEADER_BYTES = 7;   // [2][x s16][y s16][value u8][count u8]
const FWTEXT_MEMBER_BYTES = 7;   // [cp u32][dx s16][ink u8]

type FontWireState = {
  fontId: number;
  cellHeight: number;
  /** Encodings already registered with the Java atlas from this JS context. */
  registered: Set<number>;
};

const fontStates = new Map<GlyphFont, FontWireState>();

/**
 * Java-side image id per source image object, or null for images that can't
 * participate. Sources handed to drawImage are immutable by contract, so
 * memoizing by object identity is safe; a re-rendered icon is a new object
 * and re-resolves (usually to the same content-addressed id).
 */
const imageIds = new WeakMap<GrayImage, number | null>();

function fontWireState(font: GlyphFont): FontWireState | null {
  if (!global.isAndroid || !font.atlasKey) return null;
  if (font.lineHeight <= 0 || font.lineHeight > 255) return null;
  let state = fontStates.get(font);
  if (!state) {
    state = {
      fontId: com.faceclaw.app.GlyphAtlas.fontId(font.atlasKey),
      cellHeight: font.lineHeight,
      registered: new Set(),
    };
    fontStates.set(font, state);
  }
  return state;
}

/**
 * Whether this glyph can be expressed as an on-glasses cached draw: within
 * the mode-14 char table (32..127), a nonempty raster that fits the font's
 * line cell (the cached image is bbxWidth x lineHeight with the ink placed at
 * inkTop), and metrics that fit the wire fields.
 */
function representableGlyph(font: GlyphFont, glyph: Glyph): boolean {
  if (glyph.encoding < 32 || glyph.encoding > 127) return false;
  if (glyph.bbxWidth <= 0 || glyph.bbxWidth > 255) return false;
  if (glyph.bbxHeight <= 0 || glyph.bbxHeight > 255) return false;
  if (glyph.bbxX < -128 || glyph.bbxX > 127) return false;
  const inkTop = font.ascent - (glyph.bbxHeight + glyph.bbxY);
  return inkTop >= 0 && inkTop + glyph.bbxHeight <= font.lineHeight;
}

/** Firmware-font codepoints already registered with the Java FwGlyphAtlas. */
const fwRegistered = new Set<string>();

/**
 * Whether a firmware-text run is expressible on the wire, registering any
 * unseen ink members' rasters with the Java FwGlyphAtlas as a side effect.
 */
function prepareFwTextRun(placed: PlacedFwText): boolean {
  if (!inRange16(placed.x) || !inRange16(placed.y)) return false;
  if (placed.glyphs.length === 0 || placed.glyphs.length > 255) return false;
  let registration: Array<{ cp: number; data: NonNullable<ReturnType<PlacedFwText["font"]["fwGlyphWireData"]>> }> | null = null;
  for (const member of placed.glyphs) {
    if (member.cp < 0 || member.cp > 0x10ffff || !inRange16(member.dx)) return false;
    if (!member.ink) continue;
    const key = `${placed.font.atlasTag}:${member.cp}`;
    if (fwRegistered.has(key)) continue;
    const data = placed.font.fwGlyphWireData(member.cp);
    if (!data) return false; // ink without raster data: keep the run baked
    fwRegistered.add(key);
    registration ??= [];
    registration.push({ cp: member.cp, data });
  }
  if (registration) {
    let total = 0;
    for (const entry of registration) {
      total += 10 + entry.data.nibbles.length;
    }
    const buffer = new ArrayBuffer(total);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    let offset = 0;
    for (const entry of registration) {
      view.setUint32(offset, entry.cp, true);
      view.setInt16(offset + 4, entry.data.ofsX, true);
      view.setInt16(offset + 6, entry.data.inkTop, true);
      view.setUint8(offset + 8, entry.data.boxW);
      view.setUint8(offset + 9, entry.data.boxH);
      bytes.set(entry.data.nibbles, offset + 10);
      offset += 10 + entry.data.nibbles.length;
    }
    com.faceclaw.app.FwGlyphAtlas.register(new com.faceclaw.app.AndroidByteReader(buffer));
  }
  return true;
}

/** Resolve (registering on first sight) the Java image id for a drawImage source. */
function imageId(placed: PlacedImage): number | null {
  if (!global.isAndroid) return null;
  const source = placed.source;
  const memo = imageIds.get(source);
  if (memo !== undefined) return memo;
  let id: number | null = null;
  if (source.width > 0 && source.width <= 255 && source.height > 0 && source.height <= 255) {
    const key = `img:${source.width}x${source.height}:${source.contentHash32().toString(16)}`;
    id = com.faceclaw.app.ImageAtlas.ensure(key, source.width, source.height, new com.faceclaw.app.AndroidByteReader(source.pixels.buffer));
    if (!(typeof id === "number") || id <= 0) id = null;
  }
  imageIds.set(source, id);
  return id;
}

function inRange16(v: number): boolean {
  return v >= -32768 && v <= 32767;
}

/**
 * Register any not-yet-registered glyph rasters and image contents among
 * `draws` with the Java atlases, then build the per-frame draw buffer to pass
 * alongside the frame's pixels: little-endian tagged records
 *   [0][fontId u16][encoding u32][penX s16][lineY s16][value u8]   (glyph)
 *   [1][imageId u32][x s16][y s16]                                 (image)
 *   [2][x s16][y s16][value u8][count u8]                          (fw text run)
 *      then count x [cp u32][dx s16][ink u8]
 * in draw order. Returns null when nothing is expressible (or off-Android).
 */
export function prepareFrameDraws(draws: readonly DeferredDraw[]): ArrayBuffer | null {
  if (!global.isAndroid || draws.length === 0) return null;

  // Pass 1: resolve ids, register unseen rasters, size the buffer.
  let registration: Map<FontWireState, RegistrationGroup> | null = null;
  const fwRunOk = new Map<PlacedFwText, boolean>();
  let bytes = 0;
  for (const placed of draws) {
    if (placed.kind === "glyph") {
      const state = fontWireState(placed.font);
      if (!state || !representableGlyph(placed.font, placed.glyph)) continue;
      if (!inRange16(placed.x) || !inRange16(placed.y)) continue;
      bytes += GLYPH_RECORD_BYTES;
      if (state.registered.has(placed.glyph.encoding)) continue;
      state.registered.add(placed.glyph.encoding);
      registration ??= new Map();
      let group = registration.get(state);
      if (!group) {
        group = { font: placed.font, glyphs: [], aaGlyphs: [] };
        registration.set(state, group);
      }
      (placed.glyph.coverage ? group.aaGlyphs : group.glyphs).push(placed.glyph);
    } else if (placed.kind === "image") {
      if (!inRange16(placed.x) || !inRange16(placed.y)) continue;
      if (imageId(placed) !== null) bytes += IMAGE_RECORD_BYTES;
    } else {
      const ok = prepareFwTextRun(placed);
      fwRunOk.set(placed, ok);
      if (ok) bytes += FWTEXT_HEADER_BYTES + placed.glyphs.length * FWTEXT_MEMBER_BYTES;
    }
  }
  if (registration) {
    const plainBuffer = buildRegistrationBuffer(registration);
    if (plainBuffer) com.faceclaw.app.GlyphAtlas.register(new com.faceclaw.app.AndroidByteReader(plainBuffer));
    const aaBuffer = buildAaRegistrationBuffer(registration);
    if (aaBuffer) com.faceclaw.app.GlyphAtlas.registerAa(new com.faceclaw.app.AndroidByteReader(aaBuffer));
  }
  if (bytes === 0) return null;

  // Pass 2: the frame's draw records.
  const out = new DataView(new ArrayBuffer(bytes));
  let offset = 0;
  for (const placed of draws) {
    if (placed.kind === "glyph") {
      if (!inRange16(placed.x) || !inRange16(placed.y)) continue;
      const state = fontWireState(placed.font);
      if (!state || !representableGlyph(placed.font, placed.glyph)) continue;
      out.setUint8(offset, 0);
      out.setUint16(offset + 1, state.fontId, true);
      out.setUint32(offset + 3, placed.glyph.encoding, true);
      out.setInt16(offset + 7, placed.x, true);
      out.setInt16(offset + 9, placed.y, true);
      out.setUint8(offset + 11, placed.value);
      offset += GLYPH_RECORD_BYTES;
    } else if (placed.kind === "image") {
      if (!inRange16(placed.x) || !inRange16(placed.y)) continue;
      const id = imageId(placed);
      if (id === null) continue;
      out.setUint8(offset, 1);
      out.setUint32(offset + 1, id, true);
      out.setInt16(offset + 5, placed.x, true);
      out.setInt16(offset + 7, placed.y, true);
      offset += IMAGE_RECORD_BYTES;
    } else {
      if (!fwRunOk.get(placed)) continue;
      out.setUint8(offset, 2);
      out.setInt16(offset + 1, placed.x, true);
      out.setInt16(offset + 3, placed.y, true);
      out.setUint8(offset + 5, placed.value);
      out.setUint8(offset + 6, placed.glyphs.length);
      offset += FWTEXT_HEADER_BYTES;
      for (const member of placed.glyphs) {
        out.setUint32(offset, member.cp, true);
        out.setInt16(offset + 4, member.dx, true);
        out.setUint8(offset + 6, member.ink ? 1 : 0);
        offset += FWTEXT_MEMBER_BYTES;
      }
    }
  }
  return out.buffer;
}

type RegistrationGroup = {
  font: GlyphFont;
  /** 1bpp (BDF) glyphs for GlyphAtlas.register. */
  glyphs: Glyph[];
  /** Antialiased (coverage) glyphs for GlyphAtlas.registerAa. */
  aaGlyphs: Glyph[];
};

/**
 * 1bpp registration buffer: per font group
 *   [keyLen u8][key utf8][cellHeight u8][count u16]
 * then per glyph
 *   [encoding u32][bbxX s8][inkTop u8][width u8][inkHeight u8]
 *   [inkHeight x row u32]   (bit (ceil(width/8)*8 - 1 - col) = ink)
 * mirroring GlyphAtlas.register on the Java side. Null when the groups hold
 * no 1bpp glyphs.
 */
function buildRegistrationBuffer(
  registration: Map<FontWireState, RegistrationGroup>,
): ArrayBuffer | null {
  return buildGroupedBuffer(
    registration,
    (group) => group.glyphs,
    (glyph) => 8 + 4 * glyph.bbxHeight,
    (view, _bytes, offset, group, glyph) => {
      writeGlyphHeader(view, offset, group, glyph);
      offset += 8;
      for (let row = 0; row < glyph.bbxHeight; row++) {
        view.setUint32(offset, (glyph.bitmapRows[row] ?? 0) >>> 0, true);
        offset += 4;
      }
      return offset;
    },
  );
}

/**
 * AA registration buffer: same group framing, but each glyph record carries
 * packed 4bpp coverage instead of 1bpp rows:
 *   [encoding u32][bbxX s8][inkTop u8][width u8][inkHeight u8]
 *   [inkHeight x ceil(width/2) packed bytes, high nibble = left pixel]
 * mirroring GlyphAtlas.registerAa. Null when the groups hold no AA glyphs.
 */
function buildAaRegistrationBuffer(
  registration: Map<FontWireState, RegistrationGroup>,
): ArrayBuffer | null {
  return buildGroupedBuffer(
    registration,
    (group) => group.aaGlyphs,
    (glyph) => 8 + ((glyph.bbxWidth + 1) >> 1) * glyph.bbxHeight,
    (view, bytes, offset, group, glyph) => {
      writeGlyphHeader(view, offset, group, glyph);
      offset += 8;
      const coverage = glyph.coverage!;
      const stride = (glyph.bbxWidth + 1) >> 1;
      for (let row = 0; row < glyph.bbxHeight; row++) {
        const rowStart = row * glyph.bbxWidth;
        for (let b = 0; b < stride; b++) {
          const col = b * 2;
          const high = coverage[rowStart + col]! & 0x0f;
          const low = col + 1 < glyph.bbxWidth ? coverage[rowStart + col + 1]! & 0x0f : 0;
          bytes[offset++] = (high << 4) | low;
        }
      }
      return offset;
    },
  );
}

/** [encoding u32][bbxX s8][inkTop u8][width u8][inkHeight u8], shared by both formats. */
function writeGlyphHeader(view: DataView, offset: number, group: RegistrationGroup, glyph: Glyph): void {
  const inkTop = group.font.ascent - (glyph.bbxHeight + glyph.bbxY);
  view.setUint32(offset, glyph.encoding, true);
  view.setInt8(offset + 4, glyph.bbxX);
  view.setUint8(offset + 5, inkTop);
  view.setUint8(offset + 6, glyph.bbxWidth);
  view.setUint8(offset + 7, glyph.bbxHeight);
}

/** Shared group-framing walk for the two registration formats. */
function buildGroupedBuffer(
  registration: Map<FontWireState, RegistrationGroup>,
  glyphsOf: (group: RegistrationGroup) => Glyph[],
  glyphBytes: (glyph: Glyph) => number,
  writeGlyph: (
    view: DataView,
    bytes: Uint8Array,
    offset: number,
    group: RegistrationGroup,
    glyph: Glyph,
  ) => number,
): ArrayBuffer | null {
  let total = 0;
  let glyphCount = 0;
  const encodedKeys = new Map<FontWireState, Uint8Array>();
  registration.forEach((group, state) => {
    const glyphs = glyphsOf(group);
    if (glyphs.length === 0) return;
    const keyBytes = utf8Encode(group.font.atlasKey ?? "");
    encodedKeys.set(state, keyBytes);
    total += 1 + keyBytes.length + 1 + 2;
    glyphCount += glyphs.length;
    for (const glyph of glyphs) {
      total += glyphBytes(glyph);
    }
  });
  if (glyphCount === 0) return null;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  registration.forEach((group, state) => {
    const glyphs = glyphsOf(group);
    if (glyphs.length === 0) return;
    const keyBytes = encodedKeys.get(state)!;
    view.setUint8(offset, keyBytes.length);
    bytes.set(keyBytes, offset + 1);
    offset += 1 + keyBytes.length;
    view.setUint8(offset, state.cellHeight);
    view.setUint16(offset + 1, glyphs.length, true);
    offset += 3;
    for (const glyph of glyphs) {
      offset = writeGlyph(view, bytes, offset, group, glyph);
    }
  });
  return buffer;
}

function utf8Encode(text: string): Uint8Array {
  // TextEncoder exists in NativeScript's JS runtime; fall back to code units
  // (atlas keys are ASCII font names, so both paths agree).
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text);
  }
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    out[i] = text.charCodeAt(i) & 0x7f;
  }
  return out;
}
