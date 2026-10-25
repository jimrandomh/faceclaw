/**
 * Font options for EvenHub text and list containers (the extension layout's
 * `font: { family, size, weight }`): parsing, inheritance from the layout's
 * default, and choosing a face from what is installed. Pure, so it can be
 * tested without NativeScript; app/apps/evenhub/fonts.ts loads the result.
 *
 * A container with no font anywhere keeps the stock firmware font, exactly as
 * on stock. Naming any font option switches to Faceclaw's fonts, with the
 * defaults below filling the options left out.
 */

/** A container's font request, after parsing. Absent fields take the defaults. */
export type EvenHubFontSpec = {
  family?: string;
  size?: number;
  weight?: number;
};

export const DEFAULT_FONT_FAMILY = "Roboto";
/** The stock firmware font's size, so switching family alone keeps text about the same size. */
export const DEFAULT_FONT_SIZE = 20;
export const DEFAULT_FONT_WEIGHT = 400;
export const MIN_FONT_SIZE = 6;
/** Larger glyphs leave the glyph-cache path (255px limit), so text stops being cheap to send. */
export const MAX_FONT_SIZE = 128;

/**
 * Parse a `font` object from a layout or container. Undefined when there is
 * none; unusable fields are dropped, so `{}` means "Faceclaw's default font".
 */
export function parseFontSpec(raw: unknown): EvenHubFontSpec | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const spec: EvenHubFontSpec = {};
  if (typeof record.family === "string" && record.family.trim()) spec.family = record.family.trim();
  const size = typeof record.size === "string" ? Number(record.size) : record.size;
  if (typeof size === "number" && Number.isFinite(size)) {
    spec.size = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)));
  }
  const weight = parseWeight(record.weight);
  if (weight !== undefined) spec.weight = weight;
  return spec;
}

function parseWeight(raw: unknown): number | undefined {
  if (typeof raw === "string") {
    const keyword = raw.trim().toLowerCase();
    if (keyword === "normal") return 400;
    if (keyword === "bold") return 700;
    raw = Number(keyword);
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.min(1000, Math.max(1, Math.round(raw)));
}

/** A container's font: its own options over the layout default's, field by field. */
export function mergeFontSpecs(
  layoutDefault: EvenHubFontSpec | undefined,
  own: EvenHubFontSpec | undefined,
): EvenHubFontSpec | undefined {
  if (!layoutDefault) return own;
  if (!own) return layoutDefault;
  return { ...layoutDefault, ...own };
}

/** One loadable face: a TTF file, a Terminus weight, or the stock font. */
export type FontFaceCandidate = {
  /** Family as the font names itself (e.g. "Inter 18pt"). */
  family: string;
  /** 100..900. */
  weight: number;
  /** The sizes a bitmap face comes in; null for a scalable face. */
  sizes: readonly number[] | null;
  monospace: boolean;
  /** Identifies the face to the loader. */
  key: string;
};

/**
 * The family name apps use: an optical-size suffix ("Inter 18pt") is dropped,
 * since the bundled Inter is its 18pt cut and apps would ask for "Inter".
 */
export function displayFamily(family: string): string {
  return family.replace(/\s+\d+\s*pt$/i, "").trim() || family;
}

function normalizeFamily(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function familyMatches(candidate: string, requested: string): boolean {
  const wanted = normalizeFamily(requested);
  return normalizeFamily(candidate) === wanted || normalizeFamily(displayFamily(candidate)) === wanted;
}

/**
 * Pick the face and pixel size for a spec. An unknown family falls back to
 * DEFAULT_FONT_FAMILY; null when even that is missing (the caller then uses
 * the stock font). Weight follows CSS's font matching: 400–500 look up to
 * 500 first, lighter requests look lighter first, heavier ones heavier
 * first. A bitmap face takes its nearest size (the smaller on a tie).
 */
export function selectFontFace(
  spec: EvenHubFontSpec,
  candidates: readonly FontFaceCandidate[],
): { face: FontFaceCandidate; size: number } | null {
  const family = spec.family ?? DEFAULT_FONT_FAMILY;
  let faces = candidates.filter((candidate) => familyMatches(candidate.family, family));
  if (faces.length === 0) faces = candidates.filter((candidate) => familyMatches(candidate.family, DEFAULT_FONT_FAMILY));
  if (faces.length === 0) return null;
  const desired = spec.weight ?? DEFAULT_FONT_WEIGHT;
  const face = [...faces].sort((a, b) => weightRank(a.weight, desired) - weightRank(b.weight, desired))[0]!;
  const requestedSize = spec.size ?? DEFAULT_FONT_SIZE;
  return { face, size: face.sizes ? nearestSize(face.sizes, requestedSize) : requestedSize };
}

/** Lower is better: CSS font-weight matching as a sort key. */
function weightRank(weight: number, desired: number): number {
  const distance = Math.abs(weight - desired);
  if (weight === desired) return 0;
  if (desired >= 400 && desired <= 500) {
    if (weight > desired && weight <= 500) return distance;
    if (weight < desired) return 1000 + distance;
    return 2000 + distance;
  }
  const preferLighter = desired < 400;
  return (weight < desired) === preferLighter ? distance : 1000 + distance;
}

function nearestSize(sizes: readonly number[], requested: number): number {
  let best = sizes[0]!;
  for (const size of sizes) {
    const better = Math.abs(size - requested) < Math.abs(best - requested) ||
      (Math.abs(size - requested) === Math.abs(best - requested) && size < best);
    if (better) best = size;
  }
  return best;
}

/** A family as the extension's getFonts() reports it. */
export type FontFamilyInfo = {
  family: string;
  weights: number[];
  /** Bitmap families' sizes; absent for scalable families. */
  sizes?: number[];
  monospace: boolean;
};

/** Group faces into families for getFonts(), sorted by name. */
export function describeFontFamilies(candidates: readonly FontFaceCandidate[]): FontFamilyInfo[] {
  const families = new Map<string, FontFamilyInfo>();
  for (const candidate of candidates) {
    const name = displayFamily(candidate.family);
    const key = normalizeFamily(name);
    let info = families.get(key);
    if (!info) {
      info = { family: name, weights: [], monospace: candidate.monospace };
      families.set(key, info);
    }
    if (!info.weights.includes(candidate.weight)) info.weights.push(candidate.weight);
    if (candidate.sizes) info.sizes = Array.from(new Set([...(info.sizes ?? []), ...candidate.sizes]));
    info.monospace = info.monospace && candidate.monospace;
  }
  return Array.from(families.values())
    .map((info) => ({
      ...info,
      weights: [...info.weights].sort((a, b) => a - b),
      ...(info.sizes ? { sizes: [...info.sizes].sort((a, b) => a - b) } : {}),
    }))
    .sort((a, b) => a.family.localeCompare(b.family));
}
