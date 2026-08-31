import { type GrayImage } from "../../graphics/image";
import { ICON_SVGS, renderSvgIcon } from "../../graphics/icons";
import { ensurePreinstalledFonts, installedFontPath } from "../../graphics/installed-fonts";
import { TtfFont } from "../../graphics/ttf-font";

// The calendar icon minus its divider line, freeing the whole box for the
// date digits. Derived from the shared SVG so the outline stays in sync.
const DIVIDER = '<path d="M3 10h18"/>';
const CALENDAR_BLANK_SVG = ICON_SVGS.calendar.replace(DIVIDER, "");

// One entry per requested size (launcher 44, sidebar 32/28); replaced when the
// day rolls over. A fresh image object per (size, day) keeps downstream
// per-object caches (texture cache, the sidebar's inverted-icon memo) correct.
const cache = new Map<number, { day: number; image: GrayImage }>();

/**
 * Digit font: bundled Roboto scaled to the icon (not the user-selected UI
 * font, so the digits always fit the icon's box). Loaded once per icon size.
 */
const digitFonts = new Map<number, TtfFont | null>();
function loadDigitFont(size: number): TtfFont | null {
  let font = digitFonts.get(size);
  if (font === undefined) {
    ensurePreinstalledFonts(); // the icon can render before any font picker use
    font = TtfFont.load(installedFontPath("Roboto-Regular.ttf"), Math.round(size / 2));
    digitFonts.set(size, font);
  }
  return font;
}

/**
 * The calendar icon with today's day-of-month drawn in its body, like a phone
 * calendar app icon.
 */
export function renderCalendarDateIcon(size: number): GrayImage | null {
  const day = new Date().getDate();
  const cached = cache.get(size);
  if (cached && cached.day === day) return cached.image;
  const base = renderSvgIcon("calendar-blank", CALENDAR_BLANK_SVG, size);
  if (!base) return null;
  // Without the digits the divider-less icon reads as broken; a null return
  // gets both call sites' stock-calendar fallback instead.
  const font = loadDigitFont(size);
  if (!font) return null;
  const image = base.clone();
  const text = String(day);
  // Center in the box interior (viewBox y 5..21 of 24, inside the stroke),
  // nudged down so the digits sit clear of the top-edge hanging tabs.
  const x = Math.round((size - font.measureText(text)) / 2);
  const y = Math.round((size * 13.5) / 24 - font.lineHeight / 2);
  image.drawText(font, x, y, text, 255);
  image.bakeDeferredDrawsInPlace();
  cache.set(size, { day, image });
  return image;
}
