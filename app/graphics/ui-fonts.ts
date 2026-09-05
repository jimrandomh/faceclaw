/**
 * The user-selectable UI fonts: resolves the font settings (chosen in the
 * Settings app's font picker) to concrete BdfFont/TtfFont instances for the
 * three UI size roles, plus the terminal's separate monospace font.
 *
 * Selections are stored as one JSON value per setting so a font/size change
 * is atomic. Resolution is cached per isolate and invalidated by the settings
 * broadcast, matching the old getDefaultSmallFont pattern (these getters are
 * called per menu row per paint).
 */
import { getFont, type BdfFont } from "./bdffont";
import type { UiFont } from "./image";
import { TtfFont } from "./ttf-font";
import { ensurePreinstalledFonts, getInstalledFont, installedFontPath } from "./installed-fonts";
import { getStringSetting, onSettingsStoreChanged, setStringSetting } from "../native/settings-store";

export type BitmapFace = "terminus" | "terminusv";

export type UiFontSelection =
  | { kind: "bitmap"; face: BitmapFace }
  | { kind: "ttf"; file: string; size: number };

export const UI_FONT_SELECTION_KEY = "display.uiFont2";
export const TERMINAL_FONT_SELECTION_KEY = "terminal.font";
/** Pre-picker setting ("terminus" | "terminusv"), read as a migration default. */
const LEGACY_UI_FONT_KEY = "display.uiFont";

/** Line-height floors for the medium/large UI font roles (bitmap: 16/24px faces). */
const MEDIUM_MIN_LINE_HEIGHT = 20;
const LARGE_MIN_LINE_HEIGHT = 26;
/** How far size can grow hunting a line-height floor before giving up. */
const MAX_SIZE_GROWTH = 48;

/**
 * Guaranteed line-height range of getDefaultSmallFont, which UI layouts may
 * rely on (getDefaultMediumFont's range follows: 16..29). The font picker
 * hides sizes outside it, and resolution falls back to the bitmap face if
 * a stored selection somehow lands outside (e.g. the font file changed).
 */
export const SMALL_FONT_MIN_LINE_HEIGHT = 8;
export const SMALL_FONT_MAX_LINE_HEIGHT = 21;

/** Whether a small-font selection at this path+size satisfies the UI bound. */
export function uiFontSizeAllowed(path: string, size: number): boolean {
  ensurePreinstalledFonts(); // the default selection may precede any picker use
  const font = TtfFont.load(path, size);
  return (
    font !== null &&
    font.lineHeight >= SMALL_FONT_MIN_LINE_HEIGHT &&
    font.lineHeight <= SMALL_FONT_MAX_LINE_HEIGHT
  );
}

export function parseFontSelection(raw: string): UiFontSelection | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const sel = parsed as Record<string, unknown>;
    if (sel.kind === "bitmap" && (sel.face === "terminus" || sel.face === "terminusv")) {
      return { kind: "bitmap", face: sel.face };
    }
    if (
      sel.kind === "ttf" &&
      typeof sel.file === "string" && sel.file.length > 0 &&
      typeof sel.size === "number" && Number.isFinite(sel.size) && sel.size >= 6 && sel.size <= 64
    ) {
      return { kind: "ttf", file: sel.file, size: Math.round(sel.size) };
    }
  } catch {
    // fall through
  }
  return null;
}

/** Default UI font when the user has never picked one. */
const DEFAULT_UI_FONT: UiFontSelection = { kind: "ttf", file: "Roboto-Light.ttf", size: 14 };

export function getUiFontSelection(): UiFontSelection {
  const parsed = parseFontSelection(getStringSetting(UI_FONT_SELECTION_KEY, ""));
  if (parsed) return parsed;
  // A pre-picker-era explicit bitmap choice is honored; fresh states get the
  // bundled default.
  const legacy = getStringSetting(LEGACY_UI_FONT_KEY, "");
  if (legacy === "terminus" || legacy === "terminusv") {
    return { kind: "bitmap", face: legacy };
  }
  return DEFAULT_UI_FONT;
}

export function setUiFontSelection(selection: UiFontSelection): void {
  setStringSetting(UI_FONT_SELECTION_KEY, JSON.stringify(selection));
}

export function getTerminalFontSelection(): UiFontSelection {
  return parseFontSelection(getStringSetting(TERMINAL_FONT_SELECTION_KEY, "")) ?? { kind: "bitmap", face: "terminus" };
}

export function setTerminalFontSelection(selection: UiFontSelection): void {
  setStringSetting(TERMINAL_FONT_SELECTION_KEY, JSON.stringify(selection));
}

/** Human label for a selection, e.g. "Inter Light 16" or "Terminus". */
export function fontSelectionLabel(selection: UiFontSelection): string {
  if (selection.kind === "bitmap") {
    return selection.face === "terminusv" ? "TerminusV" : "Terminus";
  }
  const installed = getInstalledFont(selection.file);
  const face = installed ? `${installed.family}${installed.style ? ` ${installed.style}` : ""}` : selection.file;
  return `${face} ${selection.size}`;
}

// --- Resolution, cached per isolate ---

const resolved = new Map<string, UiFont>();
let invalidationInstalled = false;

function cacheKey(role: string): string {
  return role;
}

function installInvalidation(): void {
  if (invalidationInstalled) return;
  invalidationInstalled = true;
  onSettingsStoreChanged((key) => {
    if (key === UI_FONT_SELECTION_KEY || key === LEGACY_UI_FONT_KEY || key === TERMINAL_FONT_SELECTION_KEY) {
      resolved.clear();
      cachedTerminalConfig = null;
    }
  });
}

/**
 * The selection's TTF at a size grown until lineHeight reaches minLineHeight
 * (never shrunk below the picked size), or null when the file can't load.
 */
function resolveTtf(selection: UiFontSelection, minLineHeight = 0): TtfFont | null {
  if (selection.kind !== "ttf") return null;
  // The default selection can be resolved before the picker (whose listing
  // preinstalls bundled faces) has ever been opened, so make sure the
  // bundled files exist first. Cheap after the first call per isolate.
  ensurePreinstalledFonts();
  const path = installedFontPath(selection.file);
  for (let size = selection.size; size <= selection.size + MAX_SIZE_GROWTH; size++) {
    const font = TtfFont.load(path, size);
    if (!font) return null;
    if (font.lineHeight >= minLineHeight) return font;
  }
  return null;
}

function resolveRole(role: "small" | "medium" | "large"): UiFont {
  installInvalidation();
  const key = cacheKey(role);
  const cached = resolved.get(key);
  if (cached) return cached;
  const selection = getUiFontSelection();
  let font: UiFont | null = null;
  // Enforce the guaranteed small-font range even against a stale or
  // hand-edited selection: an out-of-range selection falls back to bitmap for
  // every role (medium/large derive from small, so their documented ranges
  // follow and the roles never mix faces).
  if (selection.kind === "ttf" && uiFontSizeAllowed(installedFontPath(selection.file), selection.size)) {
    font =
      role === "small"
        ? resolveTtf(selection)
        : resolveTtf(selection, role === "medium" ? MEDIUM_MIN_LINE_HEIGHT : LARGE_MIN_LINE_HEIGHT);
  }
  if (!font) {
    font = bitmapForRole(selection.kind === "bitmap" ? selection.face : "terminus", role);
  }
  resolved.set(key, font);
  return font;
}

// Only the small (12px) bitmap font has a TerminusV alternative (it ships no
// larger sizes); bitmap medium/large stay Terminus, as before the picker.
function bitmapForRole(face: BitmapFace, role: "small" | "medium" | "large"): BdfFont {
  if (role === "medium") return getFont("terminus16");
  if (role === "large") return getFont("terminus24");
  return getFont(face === "terminusv" ? "terminusv12" : "terminus12");
}

export function getDefaultSmallFont(): UiFont {
  return resolveRole("small");
}
export function getDefaultMediumFont(): UiFont {
  return resolveRole("medium");
}
export function getDefaultLargeFont(): UiFont {
  return resolveRole("large");
}

// --- Terminal font ---

export type TerminalFontConfig = {
  font: UiFont;
  /** Integer cell pitch; TTF glyphs are drawn per-cell at col*cellWidth. */
  cellWidth: number;
  cellHeight: number;
};

let cachedTerminalConfig: TerminalFontConfig | null = null;

/**
 * The terminal's font and cell geometry. Note grid dimensions are baked into
 * each session's handshake, so callers capture this per window at open time;
 * a settings change applies to windows opened afterwards.
 */
export function getTerminalFontConfig(): TerminalFontConfig {
  installInvalidation();
  if (cachedTerminalConfig) return cachedTerminalConfig;
  const selection = getTerminalFontSelection();
  let config: TerminalFontConfig | null = null;
  if (selection.kind === "ttf") {
    const font = resolveTtf(selection);
    // Cell pitch from a digit's advance (all advances are equal in the
    // monospace faces the picker offers), rounded to an integer grid.
    const advance = font?.getGlyph(48)?.advance ?? 0;
    if (font && advance > 0) {
      config = { font, cellWidth: Math.max(1, Math.round(advance)), cellHeight: font.lineHeight };
    }
  }
  if (!config) {
    config = { font: getFont("terminus12"), cellWidth: 6, cellHeight: 12 };
  }
  cachedTerminalConfig = config;
  return config;
}
