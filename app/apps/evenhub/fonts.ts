/**
 * Loads the fonts EvenHub text and list containers ask for (see font-spec.ts
 * for the matching rules): the stock firmware font, Terminus at its bitmap
 * sizes, and every installed TTF/OTF — the bundled Roboto, Inter, Montserrat
 * and Roboto Mono, plus any the user installed from the Files app.
 */
import { EvenHubFont } from "../../graphics/evenhub-font";
import { getTerminusFont, TERMINUS_SIZES } from "../../graphics/bdffont";
import { TtfFont } from "../../graphics/ttf-font";
import { listInstalledFonts } from "../../graphics/installed-fonts";
import { wrapText } from "../../graphics/textwrap";
import type { GrayImage, UiFont } from "../../graphics/image";
import {
  describeFontFamilies,
  familyMatches,
  selectFontFace,
  type EvenHubFontSpec,
  type FontFaceCandidate,
  type FontFamilyInfo,
} from "./font-spec";

/** What containers draw text with: the stock font's interface, which UiFonts are adapted to. */
export type EvenHubTextFace = {
  readonly lineHeight: number;
  measureLine(text: string): number;
  wrap(text: string, maxWidth: number): string[];
  drawText(image: GrayImage, x: number, y: number, text: string, value?: number): void;
};

class UiFontFace implements EvenHubTextFace {
  constructor(private readonly font: UiFont) {}

  get lineHeight(): number {
    return this.font.lineHeight;
  }

  measureLine(text: string): number {
    return this.font.measureText(text);
  }

  wrap(text: string, maxWidth: number): string[] {
    return wrapText(this.font, text, maxWidth);
  }

  drawText(image: GrayImage, x: number, y: number, text: string, value = 255): void {
    this.font.drawText(image, x, y, text, value);
  }
}

const STOCK_KEY = "stock";
const TERMINUS_KEY_PREFIX = "terminus:";
const TTF_KEY_PREFIX = "ttf:";

const BUILT_IN_FACES: readonly FontFaceCandidate[] = [
  // The firmware font: one size, one weight.
  { family: "EvenHub", weight: 400, sizes: [20], monospace: false, key: STOCK_KEY },
  { family: "Terminus", weight: 400, sizes: TERMINUS_SIZES, monospace: true, key: `${TERMINUS_KEY_PREFIX}400` },
  { family: "Terminus", weight: 700, sizes: TERMINUS_SIZES, monospace: true, key: `${TERMINUS_KEY_PREFIX}700` },
];

/** A family the listing lacks is re-listed at most this often (the user may have just installed it). */
const RELIST_INTERVAL_MS = 30_000;

let faces: FontFaceCandidate[] | null = null;
let listedAtMs = 0;

function listFaces(): FontFaceCandidate[] {
  const installed = listInstalledFonts()
    // Upright faces only: there is no italic option yet.
    .filter((font) => font.weightOrder < 1000)
    .map((font): FontFaceCandidate => ({
      family: font.family,
      weight: font.weightOrder,
      sizes: null,
      monospace: font.monospace,
      key: `${TTF_KEY_PREFIX}${font.path}`,
    }));
  faces = [...BUILT_IN_FACES, ...installed];
  listedAtMs = Date.now();
  return faces;
}

/** Whether some listed face has the family (no family asks for the default, which is bundled). */
function hasFamily(available: readonly FontFaceCandidate[], family: string | undefined): boolean {
  return !family || available.some((face) => familyMatches(face.family, family));
}

/** Resolved faces by spec; null means the stock font (asked for, or nothing loadable). */
const resolved = new Map<string, EvenHubTextFace | null>();

/** The face for a spec, and whether it is in the family asked for (rather than the fallback). */
function loadFace(spec: EvenHubFontSpec): { face: EvenHubTextFace | null; exact: boolean } {
  let available = faces ?? listFaces();
  if (!hasFamily(available, spec.family) && Date.now() - listedAtMs > RELIST_INTERVAL_MS) available = listFaces();
  const exact = hasFamily(available, spec.family);
  return { face: openFace(selectFontFace(spec, available)), exact };
}

function openFace(choice: { face: FontFaceCandidate; size: number } | null): EvenHubTextFace | null {
  if (!choice || choice.face.key === STOCK_KEY) return null;
  const { face, size } = choice;
  if (face.key.startsWith(TERMINUS_KEY_PREFIX)) {
    const font = getTerminusFont(size, face.weight >= 600);
    return font ? new UiFontFace(font) : null;
  }
  const font = TtfFont.load(face.key.slice(TTF_KEY_PREFIX.length), size);
  return font ? new UiFontFace(font) : null;
}

/**
 * The face a container draws with: the stock font when it names no font,
 * otherwise the closest match to its spec.
 */
export function containerFace(spec: EvenHubFontSpec | undefined): EvenHubTextFace {
  if (!spec) return EvenHubFont.get();
  const key = `${spec.family ?? ""}|${spec.size ?? ""}|${spec.weight ?? ""}`;
  let face = resolved.get(key);
  if (face === undefined) {
    const loaded = loadFace(spec);
    face = loaded.face;
    // A fallback isn't kept, so a family the user installs later gets picked up.
    if (loaded.exact) resolved.set(key, face);
  }
  // Not cached as an object: EvenHubFont.get() changes once firmware fonts are extracted.
  return face ?? EvenHubFont.get();
}

/** The font families apps can ask for (extension getFonts). Re-lists installed fonts. */
export function availableFontFamilies(): FontFamilyInfo[] {
  return describeFontFamilies(listFaces());
}

/** Width of the widest line of `text` and the line height, in the font a container would use. */
export function measureContainerText(text: string, spec: EvenHubFontSpec | undefined): { width: number; lineHeight: number } {
  const face = containerFace(spec);
  let width = 0;
  for (const line of text.split("\n")) width = Math.max(width, face.measureLine(line));
  return { width: Math.ceil(width), lineHeight: face.lineHeight };
}
