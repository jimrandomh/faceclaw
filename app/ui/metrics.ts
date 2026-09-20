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
 */
import type { UiFont } from "../graphics/image";

/** Height of one selectable list/menu row (line box + breathing room). */
export function listRowHeight(font: UiFont): number {
  return font.lineHeight + 8;
}

/** Vertical inset of a listRowHeight row's text within the row. */
export const LIST_ROW_TEXT_INSET = 4;

/**
 * Height of one row in dense lists (file browser, track lists). Grows at
 * half the lineHeight's rate above the 12px anchor: TTF line heights carry
 * internal leading that already reads as row spacing, so full-rate growth
 * made large-font rows feel too tall.
 */
export function tightRowHeight(font: UiFont): number {
  return font.lineHeight + 4 - Math.floor(Math.max(0, font.lineHeight - 12) / 2);
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
