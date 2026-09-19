/**
 * Sprite assets for the Flappy game, built once per worker and never mutated
 * afterwards, so every frame can place them with GrayImage.drawImage and the
 * wire pipeline can ship them as on-glasses cached-image draws (see
 * graphics/glyph-wire.ts). A frame then costs a handful of 9-byte draw
 * records plus whatever raster is left, instead of re-sending the sprite
 * pixels every tick.
 *
 * Constraints the pipeline puts on the art (kept here so the worker doesn't
 * have to know):
 *  - a cached image is at most 255x255, so pipes are built from short body
 *    tiles under a cap rather than one tall image;
 *  - the body tile is vertically uniform (stripes only), so overlapping two
 *    tiles at any vertical offset writes identical pixels and both still
 *    match the composite the planner checks against;
 *  - value 0 is transparent (color key), so sprites use 1 for opaque black.
 */
import { GrayImage } from "../../graphics/image";

export const PIPE_W = 44;
export const PIPE_CAP_W = 52;
export const PIPE_CAP_H = 16;
/** How far the cap overhangs the body on each side. */
export const PIPE_CAP_OVERHANG = (PIPE_CAP_W - PIPE_W) / 2;
export const PIPE_BODY_TILE_H = 32;

export const GROUND_TILE_W = 96;
export const GROUND_H = 18;

export const BIRD_SPRITE_W = 30;
export const BIRD_SPRITE_H = 26;
/** Bird rotation angles the sprites are pre-rendered at, in degrees (positive = nose down). */
export const BIRD_ANGLES = [-25, 0, 25, 50, 80] as const;
export const BIRD_WING_FRAMES = 3;

const OPAQUE_BLACK = 1;

/** Vertical stripe shading across the pipe body: highlight left, shadow right. */
function pipeColumnShade(col: number, width: number): number {
  if (col === 0) return 90;
  if (col <= 3) return 210;
  if (col >= width - 1) return 60;
  if (col >= width - 4) return 95;
  return 150;
}

export function createPipeBodyTile(): GrayImage {
  const image = new GrayImage(PIPE_W, PIPE_BODY_TILE_H, 0);
  for (let col = 0; col < PIPE_W; col++) {
    image.fillRect(col, 0, 1, PIPE_BODY_TILE_H, pipeColumnShade(col, PIPE_W));
  }
  return image;
}

/** Vertically symmetric, so one tile serves as both the top and the bottom pipe's cap. */
export function createPipeCap(): GrayImage {
  const image = new GrayImage(PIPE_CAP_W, PIPE_CAP_H, 0);
  for (let col = 0; col < PIPE_CAP_W; col++) {
    image.fillRect(col, 0, 1, PIPE_CAP_H, pipeColumnShade(col, PIPE_CAP_W));
  }
  image.fillRect(0, 0, PIPE_CAP_W, 2, 220);
  image.fillRect(0, PIPE_CAP_H - 2, PIPE_CAP_W, 2, 220);
  return image;
}

/** Ground strip: a bright surface line over diagonal hatching that tiles at GROUND_TILE_W. */
export function createGroundTile(): GrayImage {
  const image = new GrayImage(GROUND_TILE_W, GROUND_H, 0);
  image.fillRect(0, 0, GROUND_TILE_W, 2, 200);
  const period = 24; // divides GROUND_TILE_W, so the hatching wraps seamlessly
  for (let y = 3; y < GROUND_H; y++) {
    for (let x = 0; x < GROUND_TILE_W; x++) {
      const phase = ((x + y) % period + period) % period;
      image.setPixel(x, y, phase < 10 ? 110 : 45);
    }
  }
  return image;
}

/**
 * The bird, rendered by sampling shapes in bird-local space so any rotation
 * and wing position comes out of the same geometry. Local x points along the
 * beak, y down; the sprite is centered on the body center.
 */
export function createBirdSprite(angleDeg: number, wingFrame: number): GrayImage {
  const image = new GrayImage(BIRD_SPRITE_W, BIRD_SPRITE_H, 0);
  const angle = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const cx = BIRD_SPRITE_W / 2;
  const cy = BIRD_SPRITE_H / 2;
  // Wing pivot sits behind the body center; the tip swings up/mid/down.
  const wingTipY = [-5, 0, 4][wingFrame % BIRD_WING_FRAMES]!;
  for (let py = 0; py < BIRD_SPRITE_H; py++) {
    for (let px = 0; px < BIRD_SPRITE_W; px++) {
      const sx = px + 0.5 - cx;
      const sy = py + 0.5 - cy;
      // Sprite space -> bird-local space (inverse rotation).
      const x = sx * cos + sy * sin;
      const y = -sx * sin + sy * cos;
      const value = birdShade(x, y, wingTipY);
      if (value > 0) image.setPixel(px, py, value);
    }
  }
  return image;
}

/** Gray value of the bird at a bird-local point, or 0 outside it. */
function birdShade(x: number, y: number, wingTipY: number): number {
  // Eye: white with a pupil, drawn first so it sits on top of the body.
  const eyeX = 4.5;
  const eyeY = -2.5;
  if (inEllipse(x - eyeX - 1.1, y - eyeY, 1.3, 1.3)) return OPAQUE_BLACK;
  if (inEllipse(x - eyeX, y - eyeY, 3.2, 3.0)) return 255;
  // Beak: a wedge off the front of the body.
  if (x >= 7 && x <= 14 && Math.abs(y - 1.5) <= 2.6 * (1 - (x - 7) / 8.5)) {
    return y < 1.5 ? 235 : 190;
  }
  // Wing: an angled lobe behind the center, swinging with the frame.
  const wx = x + 3;
  const wy = y - wingTipY * 0.5 - wingTipY * 0.35 * (wx / 6);
  if (inEllipse(wx, wy, 6.5, 3.2)) {
    return inEllipse(wx, wy, 5.0, 2.0) ? 120 : 175;
  }
  // Body: lighter belly, darker back, dark outline ring.
  if (inEllipse(x, y, 11, 8.5)) {
    if (!inEllipse(x, y, 10, 7.5)) return 110;
    return y > 2 ? 255 : 205;
  }
  return 0;
}

function inEllipse(x: number, y: number, rx: number, ry: number): boolean {
  return (x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1;
}
