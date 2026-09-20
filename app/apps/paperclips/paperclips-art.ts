/**
 * Procedural artwork for the Paperclips splash screen: an open cardboard box
 * with paperclips inside and a few spilled in front. Everything is drawn
 * with lines and fills so there is no image asset to ship, and the file
 * stays font-free (the worker adds the label text) so it can be rendered
 * off-device for tuning.
 */

/** The subset of GrayImage the artwork needs (see graphics/image.ts). */
export type ArtCanvas = {
  drawLine(x0: number, y0: number, x1: number, y1: number, value: number): void;
  fillRect(x: number, y: number, width: number, height: number, value: number): void;
};

type Point = [number, number];

/** Size of the box picture, for laying it out on the splash screen. */
export const BOX_ART_WIDTH = 262;
export const BOX_ART_HEIGHT = 214;

/** Where the worker should center the box's front-face label, relative to the art origin. */
export const BOX_LABEL_CENTER: Point = [100, 166];

/** Stroke a polyline with a roughly 2 px brush. */
function strokePath(image: ArtCanvas, points: Point[], value: number): void {
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]!;
    const [x1, y1] = points[i]!;
    image.drawLine(x0, y0, x1, y1, value);
    image.drawLine(x0 + 1, y0, x1 + 1, y1, value);
    image.drawLine(x0, y0 + 1, x1, y1 + 1, value);
  }
}

/** Append points along an arc from angle t0 to t1 (radians, y-down screen coords). */
function arcPoints(cx: number, cy: number, r: number, t0: number, t1: number, out: Point[]): void {
  const steps = Math.max(4, Math.ceil((Math.abs(t1 - t0) * r) / 2));
  for (let i = 1; i <= steps; i++) {
    const t = t0 + ((t1 - t0) * i) / steps;
    out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
}

/**
 * A gem paperclip outline in local coordinates, centered on the origin:
 * inner leg, small bottom bend, inner right leg, top bend, outer left leg,
 * big bottom bend, outer right leg.
 */
function paperclipPath(w: number, h: number): Point[] {
  const r = w / 2;
  const inset = w * 0.24;
  const pts: Point[] = [];
  pts.push([inset, h * 0.42]);
  pts.push([inset, h - r]);
  arcPoints(w / 2, h - r, r - inset, Math.PI, 0, pts);
  pts.push([w - inset, r]);
  arcPoints((w - inset) / 2, r, (w - inset) / 2, 0, -Math.PI, pts);
  pts.push([0, h - r]);
  arcPoints(w / 2, h - r, r, Math.PI, 0, pts);
  pts.push([w, h * 0.3]);
  return pts.map(([x, y]) => [x - w / 2, y - h / 2]);
}

/** Draw one paperclip centered at (cx, cy), rotated by angle (radians). */
export function drawPaperclip(
  image: ArtCanvas,
  cx: number,
  cy: number,
  angle: number,
  scale: number,
  value: number,
): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const pts = paperclipPath(16, 44).map<Point>(([x, y]) => [
    cx + (x * cos - y * sin) * scale,
    cy + (x * sin + y * cos) * scale,
  ]);
  strokePath(image, pts, value);
}

/** Scanline-fill a convex polygon. */
function fillConvexPolygon(image: ArtCanvas, pts: Point[], value: number): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of pts) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  for (let row = Math.ceil(minY); row <= Math.floor(maxY); row++) {
    let left = Infinity;
    let right = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i]!;
      const [x1, y1] = pts[(i + 1) % pts.length]!;
      if (y0 === y1) {
        if (row === y0) {
          left = Math.min(left, x0, x1);
          right = Math.max(right, x0, x1);
        }
        continue;
      }
      const lo = Math.min(y0, y1);
      const hi = Math.max(y0, y1);
      if (row < lo || row > hi) continue;
      const x = x0 + ((row - y0) * (x1 - x0)) / (y1 - y0);
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
    if (left <= right) {
      image.fillRect(Math.round(left), row, Math.round(right) - Math.round(left) + 1, 1, value);
    }
  }
}

function outlinePolygon(image: ArtCanvas, pts: Point[], value: number): void {
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[(i + 1) % pts.length]!;
    image.drawLine(x0, y0, x1, y1, value);
  }
}

function translate(pts: Point[], dx: number, dy: number): Point[] {
  return pts.map<Point>(([x, y]) => [x + dx, y + dy]);
}

/**
 * Fixed clip placements (center x, center y, angle in degrees, scale, brightness)
 * inside the box, relative to the art origin. Hand-placed rather than random
 * so the splash looks the same every launch.
 */
const INSIDE_CLIPS: Array<[number, number, number, number, number]> = [
  [86, 88, -22, 1.1, 175],
  [108, 80, 12, 1.15, 190],
  [130, 92, -70, 1.1, 165],
  [154, 78, 35, 1.2, 200],
  [178, 88, -15, 1.1, 180],
  [116, 60, 62, 1.05, 205],
  [146, 56, -50, 1.1, 215],
  [96, 64, 100, 1.0, 195],
  [170, 60, 8, 1.05, 210],
  [132, 44, 24, 1.0, 225],
];

/** Clips spilled on the ground in front of and beside the box. */
const SPILLED_CLIPS: Array<[number, number, number, number, number]> = [
  [226, 180, 78, 1.15, 215],
  [246, 198, 24, 1.1, 205],
  [206, 206, -62, 1.1, 220],
  [30, 202, 68, 1.1, 210],
  [54, 210, -20, 1.0, 200],
];

/**
 * The box: front face (with a folded-down front flap), right side, open top
 * with the back flap standing up, clips piled inside so the front rim
 * occludes them, and a few spilled clips drawn last.
 */
export function drawPaperclipBox(image: ArtCanvas, originX: number, originY: number): void {
  const t = (pts: Point[]): Point[] => translate(pts, originX, originY);

  // Geometry: front face is a rectangle; depth recedes up and to the right.
  const front: Point[] = [
    [30, 96],
    [170, 96],
    [170, 198],
    [30, 198],
  ];
  const top: Point[] = [
    [30, 96],
    [72, 66],
    [212, 66],
    [170, 96],
  ];
  const side: Point[] = [
    [170, 96],
    [212, 66],
    [212, 168],
    [170, 198],
  ];
  const backFlap: Point[] = [
    [72, 20],
    [212, 20],
    [212, 66],
    [72, 66],
  ];
  const frontFlap: Point[] = [
    [30, 96],
    [170, 96],
    [170, 134],
    [30, 134],
  ];

  // Back flap standing up behind the opening, with a crease shadow at its base.
  fillConvexPolygon(image, t(backFlap), 62);
  outlinePolygon(image, t(backFlap), 150);
  image.fillRect(originX + 72, originY + 60, 141, 6, 40);

  // The dark interior of the box.
  fillConvexPolygon(image, t(top), 10);

  // Clips inside: their lower parts hide behind the front face drawn next.
  for (const [cx, cy, deg, scale, value] of INSIDE_CLIPS) {
    drawPaperclip(image, originX + cx, originY + cy, (deg * Math.PI) / 180, scale, value);
  }

  // Front face, then the folded-down front flap over its top, then the side.
  fillConvexPolygon(image, t(front), 88);
  fillConvexPolygon(image, t(frontFlap), 112);
  fillConvexPolygon(image, t(side), 52);

  // Edges.
  outlinePolygon(image, t(front), 210);
  outlinePolygon(image, t(side), 190);
  outlinePolygon(image, t(top), 200);
  image.drawLine(originX + 30, originY + 134, originX + 170, originY + 134, 60);
  // The rim's lit top edge.
  image.fillRect(originX + 30, originY + 95, 141, 2, 235);

  // A ground shadow so the box sits on something.
  image.fillRect(originX + 34, originY + 199, 140, 2, 40);
  image.fillRect(originX + 172, originY + 170, 42, 1, 30);

  for (const [cx, cy, deg, scale, value] of SPILLED_CLIPS) {
    drawPaperclip(image, originX + cx, originY + cy, (deg * Math.PI) / 180, scale, value);
  }
}
