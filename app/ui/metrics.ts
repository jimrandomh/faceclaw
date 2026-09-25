/**
 * Font-derived layout metrics for list-style UIs, so row spacing, selection
 * highlights, and text line steps track the user's font size instead of
 * assuming the 12px bitmap default. The font picker guarantees
 * getDefaultSmallFont's lineHeight is 8..21px (and getDefaultMediumFont's
 * 16..29px — see ui-fonts.ts), so layouts driven by these helpers have
 * bounded growth.
 *
 * The formulas reproduce the pre-TTF constants exactly at the 12px default:
 * listRowHeight 20, tightRowHeight 16, lineStep 14, menuTitleHeight 16.
 * tightRowHeight follows the measured ink rather than the line box, which
 * for Terminus is the same thing.
 */
import type { UiFont } from "../graphics/image";

/** Height of one selectable list/menu row (line box + breathing room). */
export function listRowHeight(font: UiFont): number {
  return font.lineHeight + 8;
}

/** Vertical inset of a listRowHeight row's text within the row. */
export const LIST_ROW_TEXT_INSET = 4;

/**
 * Characters whose ink bounds a font's text rows: accented capitals (the
 * highest Latin marks), descenders, brackets, and digits.
 */
const INK_SAMPLE = "ÅÉÎÖÇÑbdfhklgjpqy()[]{}|/_0123456789";

export type TextInkBounds = {
  /** First inked row, relative to the drawText y (the line top); may be negative. */
  top: number;
  /** One past the last inked row, relative to the line top; may exceed lineHeight. */
  bottom: number;
};

const inkBoundsCache = new WeakMap<UiFont, TextInkBounds>();

/**
 * The vertical extent of a font's ink over a representative sample, measured
 * from the rendered glyphs. Bitmap faces fill their line box exactly; TTF
 * faces may leave internal leading inside it or overshoot it with marks.
 * Falls back to the line box when the font renders no sample ink.
 */
export function textInkBounds(font: UiFont): TextInkBounds {
  const cached = inkBoundsCache.get(font);
  if (cached) return cached;
  let top = Infinity;
  let bottom = -Infinity;
  if (typeof font.getGlyph === "function") {
    for (const char of INK_SAMPLE) {
      const glyph = font.getGlyph(char.codePointAt(0)!);
      if (!glyph || glyph.bbxHeight <= 0) continue;
      // Same placement as rasterizeGlyph: baseline at y + ascent, bbxY up from it.
      const glyphTop = font.ascent - (glyph.bbxHeight + glyph.bbxY);
      top = Math.min(top, glyphTop);
      bottom = Math.max(bottom, glyphTop + glyph.bbxHeight);
    }
  }
  const bounds = top < bottom ? { top, bottom } : { top: 0, bottom: font.lineHeight };
  inkBoundsCache.set(font, bounds);
  return bounds;
}

/** Height of a font's ink extent (see textInkBounds). */
export function textInkHeight(font: UiFont): number {
  const { top, bottom } = textInkBounds(font);
  return bottom - top;
}

/**
 * The drawText y that centers a font's ink vertically in a box, rounding the
 * spare pixel to the bottom. Pair with row heights derived from
 * textInkHeight so the ink fits whatever the face's internal leading.
 */
export function centeredTextY(font: UiFont, boxTop: number, boxHeight: number): number {
  const { top } = textInkBounds(font);
  return boxTop + Math.floor((boxHeight - textInkHeight(font)) / 2) - top;
}

/**
 * Row pitch in dense lists (file browser, track lists): the font's ink height
 * plus 4px, so a selection box one pixel shorter than the pitch keeps at
 * least a pixel of clearance around the ink. Draw the text with
 * centeredTextY; a fixed offset from the row top can overflow faces whose
 * ink starts below their line top.
 */
export function tightRowHeight(font: UiFont): number {
  return textInkHeight(font) + 4;
}

/** Step between consecutive lines of body/paragraph text. */
export function lineStep(font: UiFont): number {
  return font.lineHeight + 2;
}

/** Height of a menu/panel title band above a list. */
export function menuTitleHeight(font: UiFont): number {
  return font.lineHeight + 4;
}

/**
 * Minimum height of an icon-grid cell (icon, label line, breathing room).
 * Grid views divide their available height into as many rows of at least
 * this height as fit, so cells grow with the font instead of the label
 * overflowing a fixed-height row.
 */
export function iconGridMinRowHeight(font: UiFont, iconSize: number, labelGap: number): number {
  return iconSize + labelGap + font.lineHeight + 8;
}
