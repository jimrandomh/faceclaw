/**
 * Font-file text rendering for the on-glasses font previewer, backed by the
 * native font renderer (Android Paint / iOS Core Text). Rendered text arrives as
 * antialiased 8bpp coverage, which the compositor quantizes to the display's
 * 16 shades.
 */
import { GrayImage } from "../graphics/image";
import { grayImageFromPacket } from "./image-files";

import { fontRenderer } from "./font-renderer";
declare const global: any;

/** Font file formats supported by the native renderers. */
const FONT_FILE = /\.(ttf|otf|ttc)$/i;

export function isFontFile(name: string): boolean {
  return FONT_FILE.test(name);
}

export type FontFileMetrics = {
  /** Pixels above the baseline. */
  ascent: number;
  /** Pixels below the baseline. */
  descent: number;
  /** Extra pixels between lines beyond ascent+descent. */
  lineGap: number;
};

/**
 * Gamma applied when mapping antialiased coverage to output shade
 * (out = coverage^gamma). The G2 display response looks roughly linear, so
 * 1.0 is the default; values below 1 brighten the AA fringe (as if the
 * display were sRGB-ish), values above darken it.
 */
export const DEFAULT_FONT_GAMMA = 1.0;

/** Whether the font file parses as a loadable font. */
export function canLoadFontFile(path: string): boolean {
  if (!global.isAndroid && !global.isIOS) return false;
  try {
    return !!fontRenderer.canLoadFont(path);
  } catch {
    return false;
  }
}

/**
 * The font's family/style names from its 'name' table; null when
 * unavailable (caller should fall back to the filename).
 */
export function fontFileDisplayName(path: string): { family: string; style: string } | null {
  if (!global.isAndroid && !global.isIOS) return null;
  try {
    const raw = String(fontRenderer.getFontName(path) ?? "");
    if (!raw) return null;
    const [family, style] = raw.split("\n");
    if (!family) return null;
    return { family, style: style ?? "" };
  } catch {
    return null;
  }
}

/** Line metrics at a pixel size; null when the font cannot be loaded. */
export function fontFileMetrics(path: string, sizePx: number): FontFileMetrics | null {
  if (!global.isAndroid && !global.isIOS) return null;
  try {
    const raw = String(fontRenderer.getFontMetrics(path, sizePx) ?? "");
    const parts = raw.split(" ").map((part) => parseInt(part, 10));
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
    return { ascent: parts[0]!, descent: parts[1]!, lineGap: parts[2]! };
  } catch {
    return null;
  }
}

/**
 * Render one line of text at a pixel size. The image is the full line box
 * (ascent+descent tall); null when the font cannot be loaded or the text
 * renders to nothing.
 */
export function renderFontFileText(
  path: string,
  text: string,
  sizePx: number,
  gamma = DEFAULT_FONT_GAMMA,
): GrayImage | null {
  if (!global.isAndroid && !global.isIOS) return null;
  try {
    return grayImageFromPacket(fontRenderer.renderText(path, text, sizePx, gamma));
  } catch (error) {
    console.warn(`renderFontFileText failed for ${path}: ${error}`);
    return null;
  }
}

/**
 * Render a paragraph wrapped to maxWidth (native line breaking),
 * truncated with an ellipsis past maxLines.
 */
export function renderFontFileWrapped(opts: {
  path: string;
  text: string;
  sizePx: number;
  maxWidth: number;
  maxLines: number;
  gamma?: number;
}): GrayImage | null {
  if (!global.isAndroid && !global.isIOS) return null;
  try {
    return grayImageFromPacket(
      fontRenderer.renderWrapped(
        opts.path,
        opts.text,
        opts.sizePx,
        Math.round(opts.maxWidth),
        opts.gamma ?? DEFAULT_FONT_GAMMA,
        Math.round(opts.maxLines),
      ),
    );
  } catch (error) {
    console.warn(`renderFontFileWrapped failed for ${opts.path}: ${error}`);
    return null;
  }
}
