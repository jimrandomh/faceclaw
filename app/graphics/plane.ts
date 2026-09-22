import { GrayImage, type DeferredDraw, type PlacedImage } from "./image";

/**
 * The unit apps (and the shell) submit to the compositor: instead of one
 * flattened image, a frame is an ordered array of planes, each an image plus
 * placement metadata. Planes composite in array order, first at the bottom,
 * with the shell's transparency convention: an 8-bit value of 0 is
 * transparent, 1 is black (the two quantize to the same 4bpp shade, so
 * reserving 0 costs nothing visible).
 *
 * Static planes form the incremental screen buffer. Planes with stereo depth
 * and retained presentation draws replay from resources in the root display list.
 */
export type Plane = {
  shellKey?: number;
  depth?: number;
  dimUnderneath?: number;
  image: GrayImage;
  /**
   * Offset of the plane's top-left within the submitted frame. Applied
   * before any per-lens horizontal offset from depth.
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
 * then each image's draw order). Regular draws are baked into the image;
 * selected-menu presentation records remain unbaked for root-list replay.
 * The list preserves the draws' identity
 * so the texture-cache pipeline can replay them as on-glasses cached draws
 * (see graphics/glyph-wire.ts).
 */
export function flattenPlanesWithDraws(
  planes: readonly Plane[],
  size?: { width: number; height: number },
): { image: GrayImage; draws: DeferredDraw[] } {
  const rasters = planes.map(p => p.image.withDrawsBaked(false));
  const image = flattenPlanes(planes.map((plane, i) => ({ ...plane, image: plane.depth ? new GrayImage(plane.image.width, plane.image.height) : rasters[i]! })), size);
  const draws: DeferredDraw[] = [];
  for (const [index, plane] of planes.entries()) {
    const retained: DeferredDraw[] = [];
    if (plane.depth) {
      // Keep the whole menu off the screen buffer, including its black background.
      const raster = rasters[index]!;
      let left = raster.width, top = raster.height, right = -1, bottom = -1;
      for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) if (raster.pixels[y*raster.width+x]) {
        left = Math.min(left,x); top = Math.min(top,y); right = Math.max(right,x); bottom = Math.max(bottom,y);
      }
      if (right >= left) {
        const crop = new GrayImage(right-left+1,bottom-top+1);
        for(let y=0;y<crop.height;y++) crop.pixels.set(raster.pixels.subarray((y+top)*raster.width+left,(y+top)*raster.width+right+1),y*crop.width);
        retained.push({ kind: "image", source: crop, x: left, y: top,
          presentation: { mode: "masked-image", radius: 0, background: 0, border: 0, depth: plane.depth } });
      }
    }
    const planeDraws = plane.depth ? [...retained, ...plane.image.draws.filter(d => d.kind === "image" && d.presentation).map(d => {
      const draw = d as PlacedImage;
      return { ...draw, presentation: { ...draw.presentation!, depth: draw.presentation!.depth + plane.depth! } };
    })] : plane.image.draws;
    for (const placed of planeDraws) {
      const translated = { ...placed, x: placed.x + plane.x, y: placed.y + plane.y };
      if (translated.kind === "image" && translated.presentation) {
        // Restore opaque pixels from later planes after replaying this row. The screen
        // already contains those pixels; rect copies preserve rounded/irregular occlusion.
        const occlusions: { x: number; y: number; width: number; height: number }[] = [];
        const depth = translated.presentation.depth;
        const leftShift = Math.floor(depth / 2), rightShift = -Math.floor((depth + 1) / 2);
        const left = Math.max(0, translated.x + Math.min(leftShift, rightShift));
        const right = Math.min(image.width, translated.x + translated.source.width + Math.max(leftShift, rightShift));
        for (let y = Math.max(0, translated.y); y < Math.min(image.height, translated.y + translated.source.height); y++) {
          let start = -1;
          for (let x = left; x <= right; x++) {
            const covered = x < right && planes.some((p, i) => i > index && !p.depth && x >= p.x && y >= p.y && x < p.x + p.image.width && y < p.y + p.image.height && rasters[i]!.pixels[(y-p.y)*p.image.width+x-p.x] !== 0);
            if (covered && start < 0) start = x;
            if (!covered && start >= 0) {
              const previous = occlusions.find(r => r.x === start && r.width === x - start && r.y + r.height === y);
              if (previous) previous.height++; else occlusions.push({ x: start, y, width: x-start, height: 1 });
              start = -1;
            }
          }
        }
        translated.presentation = { ...translated.presentation, occlusions };
      }
      draws.push(translated);
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
    .map((plane) => `${plane.depth ?? 0}:${plane.x},${plane.y}+${plane.image.width}x${plane.image.height}:${plane.image.fingerprint()}`)
    .join("|");
}
