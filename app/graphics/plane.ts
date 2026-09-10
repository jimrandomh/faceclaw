import { GrayImage, type DeferredDraw } from "./image";

/**
 * The unit apps (and the shell) submit to the compositor: instead of one
 * flattened image, a frame is an ordered array of planes, each an image plus
 * placement metadata. Planes composite in array order, first at the bottom,
 * with the shell's transparency convention: an 8-bit value of 0 is
 * transparent, 1 is black (the two quantize to the same 4bpp shade, so
 * reserving 0 costs nothing visible).
 *
 * This representation exists to carry structure the wire pipeline will later
 * exploit: a plane's glyph list can become on-glasses display-list references
 * (texture cache), and the offset can diverge per lens for stereo depth. For
 * now the compositor boundary just flattens (flattenPlanes) and feeds the
 * existing incremental-update and screen-preview pipeline.
 */
export type Plane = {
  image: GrayImage;
  /**
   * Offset of the plane's top-left within the submitted frame. Applied
   * identically to both lenses for now; a per-lens divergence (stereo depth
   * for floating overlays) is the planned extension.
   */
  x: number;
  y: number;
};

/** Wrap a single full-frame image as a one-plane submission. */
export function singlePlane(image: GrayImage): Plane[] {
  return [{ image, x: 0, y: 0 }];
}

/** The planes with their brightness scaled by `factor` (see GrayImage.dimmed). */
export function dimPlanes(planes: readonly Plane[], factor: number): Plane[] {
  return planes.map((plane) => ({ ...plane, image: plane.image.dimmed(factor) }));
}

/**
 * Flatten planes into one image: for each plane in order, blend its raster
 * (0 = transparent) and then its glyphs on top. A later plane's raster covers
 * an earlier plane's glyphs — this is what lets an overlay plane occlude text
 * beneath it, which raster drawn into the *same* image cannot do (glyphs
 * always render above their own image's raster).
 *
 * The output size defaults to the planes' joint extent (in practice the base
 * plane's size, since overlays share its dimensions).
 */
export function flattenPlanes(
  planes: readonly Plane[],
  size?: { width: number; height: number },
): GrayImage {
  const width = size?.width ?? Math.max(1, ...planes.map((plane) => plane.x + plane.image.width));
  const height = size?.height ?? Math.max(1, ...planes.map((plane) => plane.y + plane.image.height));

  const only = planes.length === 1 ? planes[0]! : undefined;
  if (only && only.x === 0 && only.y === 0 && only.image.width === width && only.image.height === height) {
    return only.image.withDrawsBaked();
  }

  const target = new GrayImage(width, height, 0);
  for (const plane of planes) {
    // Baking first (rather than bitBlt's glyph carry-over) is what enforces
    // the plane ordering: the next plane's raster must be able to cover this
    // plane's glyphs.
    target.bitBlt(plane.image.withDrawsBaked(), plane.x, plane.y, { transparentZero: true });
  }
  return target;
}

/**
 * Flatten planes and also return the frame's deferred draws (glyphs and
 * images), translated into frame coordinates and in bake order (plane order,
 * then each image's draw order). The flattened image has every draw baked in,
 * exactly as flattenPlanes produces; the list preserves the draws' identity
 * so the texture-cache pipeline can replay them as on-glasses cached draws
 * (see graphics/glyph-wire.ts).
 */
export function flattenPlanesWithDraws(
  planes: readonly Plane[],
  size?: { width: number; height: number },
): { image: GrayImage; draws: DeferredDraw[] } {
  const image = flattenPlanes(planes, size);
  const draws: DeferredDraw[] = [];
  for (const plane of planes) {
    for (const placed of plane.image.draws) {
      draws.push(
        plane.x === 0 && plane.y === 0
          ? placed
          : { ...placed, x: placed.x + plane.x, y: placed.y + plane.y },
      );
    }
  }
  return { image, draws };
}

/**
 * Stable identifier for a plane stack's composited content: equal
 * fingerprints mean an equal flattened frame. Feeds the same dedupe paths
 * that single-image fingerprints did.
 */
export function planesFingerprint(planes: readonly Plane[]): string {
  return planes
    .map((plane) => `${plane.x},${plane.y}+${plane.image.width}x${plane.image.height}:${plane.image.fingerprint()}`)
    .join("|");
}
