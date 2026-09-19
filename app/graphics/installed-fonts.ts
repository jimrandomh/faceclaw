/**
 * The app-internal installed-fonts directory: the set of TTF/OTF faces the
 * font picker offers. Fonts arrive two ways — bundled faces copied out of the
 * app assets on first listing (so the directory is the single source of
 * truth), and user installs from the Files app ("Install" on a font file).
 *
 * Listing parses each file's name table for family/style (via the native
 * font renderer) and probes monospace-ness by comparing advances, both
 * memoized per path for the session.
 */
import { File, Folder, knownFolders, path as nsPath } from "@nativescript/core";
import { canLoadFontFile, fontFileDisplayName, isFontFile } from "../native/font-files";

import { fontRenderer } from "../native/font-renderer";
declare const java: any;
declare const global: any;

/** Bundled faces (under app assets fonts/ttf/) preinstalled on first listing. */
const PREINSTALLED_FONT_FILES = [
  "Inter_18pt-Light.ttf",
  "Inter_18pt-Regular.ttf",
  "Inter_18pt-Bold.ttf",
  "Montserrat-Light.ttf",
  "Montserrat-Regular.ttf",
  "Montserrat-Bold.ttf",
  "Roboto-Light.ttf",
  "Roboto-Regular.ttf",
  "Roboto-Bold.ttf",
  "RobotoMono-Light.ttf",
  "RobotoMono-Regular.ttf",
  "RobotoMono-Bold.ttf",
] as const;

export type InstalledFont = {
  /** Absolute path, loadable by TtfFont / FontFileRenderer. */
  path: string;
  fileName: string;
  /** Family name from the font's name table (filename stem as fallback). */
  family: string;
  /** Style name from the name table ("Light", "Bold", ... ; "" = regular). */
  style: string;
  /** Sort key for weight pickers (400 = regular; +1000 marks italics last). */
  weightOrder: number;
  monospace: boolean;
};

/** The app-internal fonts directory (created on first use). */
export function installedFontsDir(): string {
  return knownFolders.documents().getFolder("fonts").path;
}

/** Absolute path of an installed font by filename (existence not checked). */
export function installedFontPath(fileName: string): string {
  return nsPath.join(installedFontsDir(), fileName);
}

let preinstalledEnsured = false;

/**
 * Copy any missing bundled faces into the installed-fonts directory. Cheap
 * after the first run (existence checks only), so callers can invoke it
 * before every listing.
 */
export function ensurePreinstalledFonts(): void {
  if (preinstalledEnsured || (!global.isAndroid && !global.isIOS)) return;
  const assetsDir = nsPath.join(knownFolders.currentApp().path, "fonts/ttf");
  for (const fileName of PREINSTALLED_FONT_FILES) {
    const target = installedFontPath(fileName);
    if (File.exists(target)) continue;
    const source = nsPath.join(assetsDir, fileName);
    if (!File.exists(source)) continue;
    try {
      copyFileBytes(source, target);
    } catch (error) {
      console.warn(`Could not preinstall font ${fileName}: ${error}`);
    }
  }
  preinstalledEnsured = true;
}

/**
 * Install a font file into the installed-fonts directory (overwriting a
 * same-named file). Returns an error message for the UI, or null on success.
 */
export function installFontFile(sourcePath: string): string | null {
  if ((!global.isAndroid && !global.isIOS)) return "Not available on this platform.";
  if (!isFontFile(sourcePath)) return "Not a font file.";
  if (!canLoadFontFile(sourcePath)) return "This file could not be loaded as a font.";
  const fileName = sourcePath.slice(sourcePath.lastIndexOf("/") + 1);
  try {
    copyFileBytes(sourcePath, installedFontPath(fileName));
    metadataCache.delete(installedFontPath(fileName));
    return null;
  } catch (error) {
    console.warn(`installFontFile failed for ${sourcePath}: ${error}`);
    return "Could not copy the font file.";
  }
}

/** Whether a same-named font is already installed. */
export function isFontInstalled(sourcePath: string): boolean {
  const fileName = sourcePath.slice(sourcePath.lastIndexOf("/") + 1);
  return File.exists(installedFontPath(fileName));
}

/**
 * All installed fonts (preinstalling bundled faces first), sorted by family
 * then weight. Unloadable files are skipped.
 */
export function listInstalledFonts(): InstalledFont[] {
  if ((!global.isAndroid && !global.isIOS)) return [];
  ensurePreinstalledFonts();
  const fonts: InstalledFont[] = [];
  try {
    for (const entity of Folder.fromPath(installedFontsDir()).getEntitiesSync()) {
      if (!isFontFile(entity.name)) continue;
      const meta = fontMetadata(entity.path, entity.name);
      if (meta) fonts.push(meta);
    }
  } catch (error) {
    console.warn(`listInstalledFonts failed: ${error}`);
  }
  fonts.sort((a, b) =>
    a.family.localeCompare(b.family) || a.weightOrder - b.weightOrder || a.style.localeCompare(b.style),
  );
  return fonts;
}

/** The installed font with this filename, or null. */
export function getInstalledFont(fileName: string): InstalledFont | null {
  const path = installedFontPath(fileName);
  if (!File.exists(path)) return null;
  return fontMetadata(path, fileName);
}

const metadataCache = new Map<string, InstalledFont | null>();

function fontMetadata(path: string, fileName: string): InstalledFont | null {
  const cached = metadataCache.get(path);
  if (cached !== undefined) return cached;
  let meta: InstalledFont | null = null;
  if (canLoadFontFile(path)) {
    const name = fontFileDisplayName(path);
    const family = name?.family || fileName.replace(/\.[^.]+$/, "");
    const style = normalizeStyle(name?.style ?? "");
    meta = {
      path,
      fileName,
      family,
      style,
      weightOrder: styleWeightOrder(style),
      monospace: isMonospaceFont(path),
    };
  }
  metadataCache.set(path, meta);
  return meta;
}

function normalizeStyle(style: string): string {
  const trimmed = style.trim();
  return trimmed === "Regular" ? "" : trimmed;
}

/** OS/2-style weight for a style name; italics sort after all uprights. */
function styleWeightOrder(style: string): number {
  const withoutItalic = style.replace(/\bitalic\b/i, "").trim().toLowerCase();
  const weights: Record<string, number> = {
    "thin": 100,
    "extralight": 200,
    "extra light": 200,
    "ultralight": 200,
    "light": 300,
    "": 400,
    "regular": 400,
    "normal": 400,
    "medium": 500,
    "semibold": 600,
    "semi bold": 600,
    "demibold": 600,
    "bold": 700,
    "extrabold": 800,
    "extra bold": 800,
    "black": 900,
    "heavy": 900,
  };
  const weight = weights[withoutItalic] ?? 400;
  return /\bitalic\b/i.test(style) ? weight + 1000 : weight;
}

/**
 * Whether the face is monospace: narrow, wide, and punctuation glyphs all
 * measure the same advance. Measured at a large size so fractional advance
 * differences show up clearly.
 */
function isMonospaceFont(path: string): boolean {
  try {
    const measure = (text: string) =>
      Number(fontRenderer.measureTextExact(path, text, 48));
    const narrow = measure("i");
    if (!(narrow > 0)) return false;
    return (
      Math.abs(measure("W") - narrow) < 0.5 &&
      Math.abs(measure("m") - narrow) < 0.5 &&
      Math.abs(measure(".") - narrow) < 0.5
    );
  } catch {
    return false;
  }
}

// Plain stream/channel copy: java.nio.file.Paths.get is a varargs overload
// set that NativeScript's JNI overload resolution picks wrong (it tries the
// (URI) form for a JS string), so java.nio.file is avoided here.
//
// Written to a temp name and renamed into place (atomic on the same
// filesystem): preinstallation can be triggered concurrently from several JS
// isolates on first launch (each resolving the default UI font), and readers
// must never see a half-written font file.
function copyFileBytes(source: string, target: string): void {
  if (source === target) return;
  if (global.isIOS) {
    const data = NSData.dataWithContentsOfFile(source);
    // Foundation's atomic write uses a sibling temporary file and rename.
    // Multiple worker isolates can safely preinstall the same bundled face.
    if (!data || !data.writeToFileAtomically(target, true)) throw new Error(`Copy to ${target} failed`);
    return;
  }
  const temp = `${target}.tmp-${Math.floor(Math.random() * 0x7fffffff).toString(36)}`;
  const input = new java.io.FileInputStream(source);
  try {
    const output = new java.io.FileOutputStream(temp);
    try {
      const inChannel = input.getChannel();
      output.getChannel().transferFrom(inChannel, 0, inChannel.size());
    } finally {
      output.close();
    }
  } finally {
    input.close();
  }
  if (!new java.io.File(temp).renameTo(new java.io.File(target))) {
    new java.io.File(temp).delete();
    throw new Error(`rename to ${target} failed`);
  }
}
