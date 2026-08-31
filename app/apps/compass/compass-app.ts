import { getDefaultLargeFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import {
  COMPASS_CALIBRATION_COMPLETE,
  COMPASS_CALIBRATION_STARTED,
  COMPASS_CHANGED,
  addCompassListener,
  setCompassEnabled,
  type CompassEvent,
} from "../../native/compass";
import { wrapText } from "../../graphics/textwrap";
import { type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext } from "../../ui/layers";
import { lineStep } from "../../ui/metrics";
import { screenCenterInViewportX } from "../../ui/shell/geometry";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";
import { calibrateHeading, isCompassCalibrated, normalizeHeading } from "./calibration";
import { CompassCalibrationLayer } from "./calibration-layer";

export const COMPASS_WINDOW_ID = "compass";
export const COMPASS_SURFACE_ID = "window:compass";
const RECONCILE_INTERVAL_MS = 400;
/** Vertical breathing room between the readout, the status line and the rose. */
const STACK_GAP = 8;
/** Padding above the readout and below the rose's near edge. */
const TOP_PAD = 2;
const BOTTOM_PAD = 4;
/** Clearance between the rose's widest point and the viewport edge. */
const EDGE_PAD = 8;
/** Cap on the rose's radius, so a tall window doesn't get a comical one. */
const MAX_ROSE_RADIUS = 98;

/**
 * The rose is drawn as a flat disc lying in front of the wearer, tilted away
 * from vertical: `TILT_SQUASH` is how much that tilt shortens the depth axis,
 * and `TILT_PERSPECTIVE` how much nearer parts of the disc are magnified
 * relative to farther ones. Together they turn the ring into an egg-shaped
 * oval — wider and taller at the bottom — and give the rose's points their
 * foreshortening for free.
 */
const TILT_SQUASH = 0.42;
const TILT_PERSPECTIVE = 0.22;
/** Screen height of the projected ring, per unit of radius. */
const RING_HEIGHT_PER_RADIUS =
  TILT_SQUASH * (1 / (1 + TILT_PERSPECTIVE) + 1 / (1 - TILT_PERSPECTIVE));
/** Screen half-width of the projected ring, per unit of radius. */
const RING_HALF_WIDTH_PER_RADIUS = 1 / Math.sqrt(1 - TILT_PERSPECTIVE * TILT_PERSPECTIVE);

/** Tip radii of the rose's long and short points, as a fraction of the ring. */
const CARDINAL_TIP = 0.9;
const INTERCARDINAL_TIP = 0.54;
/** Radius the point bases sit on: how fat the rose is at its waist. */
const POINT_BASE_RADIUS = 0.17;
/** Half-angle of a point's base. 22.5° makes neighbouring bases just meet. */
const POINT_BASE_HALF_ANGLE = 22.5;
/**
 * A polar grid lying in the same plane as the disc, to give it somewhere to
 * sit and to fill the empty flanks either side of it. Rings are multiples of
 * the disc's radius; spokes are offset by half a step so none runs up the
 * middle into the heading tick.
 */
const PLANE_RINGS = [1.35, 1.8, 2.5, 3.6, 5.6];
const PLANE_SPOKE_STEP = 30;
/** Grid brightness at the disc's rim, and how fast it falls off with distance. */
const PLANE_NEAR_VALUE = 78;
const PLANE_FALLOFF = 0.55;
/** Dimmer than this is left unpainted, so the grid ends by vanishing. */
const PLANE_CUTOFF = 22;
/** Height over which the grid fades out as it approaches the readout. */
const PLANE_FADE_SPAN = 45;

/** Size of the fixed tick that marks the direction the wearer is facing. */
const TICK_HEIGHT = 7;
const TICK_HALF_WIDTH = 4;
/** Depth of the disc's side wall, as a fraction of the ring's radius. */
const DISC_DEPTH = 0.1;
/**
 * Rim angle at which the silhouette turns vertical. Between this and its
 * mirror the wall faces the wearer; outside it the rim curves back away, so a
 * wall drawn there would hook inward instead of ending on the vertical edge.
 */
const WALL_START_ANGLE = (Math.acos(-TILT_PERSPECTIVE) * 180) / Math.PI;
/** Side-wall shading, from the edges of the silhouette to the nearest point. */
const WALL_DARK = 20;
const WALL_LIT = 62;

class CompassLayer implements Layer {
  private rawHeading: number | null = null;
  /** A firmware calibration message, shown until the next heading arrives. */
  private firmwareStatus: string | null = null;
  private enabled = false;
  private removed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly requestRender: () => void) {}

  start(): void {
    this.unsubscribe = addCompassListener((event) => this.onCompassEvent(event));
    this.timer = setInterval(() => this.reconcile(), RECONCILE_INTERVAL_MS);
    this.reconcile();
  }

  stop(): void {
    if (this.removed) return;
    this.removed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.enabled) setCompassEnabled(false);
    this.enabled = false;
  }

  onRemoved(): void {
    this.stop();
  }

  openCalibration(ctx: LayerContext): void {
    if (ctx.stack.topMatches((layer) => layer instanceof CompassCalibrationLayer)) return;
    ctx.stack.push(new CompassCalibrationLayer(() => this.rawHeading));
  }

  private reconcile(): void {
    if (this.removed) return;
    const visible = shell.isWindowVisible(COMPASS_WINDOW_ID);
    if (visible === this.enabled) return;
    this.enabled = visible;
    setCompassEnabled(visible);
    this.firmwareStatus = null;
    this.requestRender();
  }

  private onCompassEvent(event: CompassEvent): void {
    if (this.removed) return;
    if (event.command === COMPASS_CHANGED && event.headingDegrees >= 0) {
      this.rawHeading = normalizeHeading(event.headingDegrees);
      this.firmwareStatus = null;
    } else if (event.command === COMPASS_CALIBRATION_STARTED) {
      this.firmwareStatus = "Calibrating — move the glasses";
    } else if (event.command === COMPASS_CALIBRATION_COMPLETE) {
      this.firmwareStatus = "Calibration complete";
    }
    this.requestRender();
  }

  private statusText(): string {
    if (this.firmwareStatus !== null) return this.firmwareStatus;
    if (!this.enabled) return "Compass paused";
    if (this.rawHeading === null) return "Waiting for compass data…";
    return isCompassCalibrated() ? "Magnetic heading" : "Uncalibrated - Tap to calibrate";
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const small = getDefaultSmallFont();
    const large = getDefaultLargeFont();
    const heading = this.rawHeading === null ? null : calibrateHeading(this.rawHeading);
    const headingText = heading === null ? "--°" : `${Math.round(heading)}° ${cardinalDirection(heading)}`;
    const statusLines = wrapText(small, this.statusText(), width - STACK_GAP * 2);
    const smallStep = lineStep(small);

    // One column centred on the display's true centre, so the rose sits where
    // the wearer is looking rather than 32px right of it.
    const cx = screenCenterInViewportX();

    // The rose is sized and placed first — it hangs off the bottom edge — and
    // the readout then floats in whatever room is left above it.
    const textHeight = large.lineHeight + 4 + statusLines.length * smallStep;
    const radius = Math.max(
      24,
      Math.min(
        MAX_ROSE_RADIUS,
        Math.floor(
          (height - BOTTOM_PAD - TOP_PAD - textHeight - STACK_GAP - TICK_HEIGHT)
            / (RING_HEIGHT_PER_RADIUS + DISC_DEPTH),
        ),
        Math.floor((Math.min(cx, width - cx) - EDGE_PAD) / RING_HALF_WIDTH_PER_RADIUS),
      ),
    );
    // The wall hangs below the rim, so the near rim sits a wall's depth up
    // from the bottom padding rather than on it.
    const cy = height - BOTTOM_PAD - discDepth(radius) - (radius * TILT_SQUASH) / (1 - TILT_PERSPECTIVE);
    const ringTop = cy - (radius * TILT_SQUASH) / (1 + TILT_PERSPECTIVE);

    let y = Math.max(TOP_PAD, Math.round((ringTop - TICK_HEIGHT - textHeight) / 2));
    image.drawText(large, Math.round(cx - large.measureText(headingText) / 2), y, headingText, heading === null ? 150 : 255);
    y += large.lineHeight + 4;
    for (const line of statusLines) {
      image.drawText(small, Math.round(cx - small.measureText(line) / 2), y, line, 125);
      y += smallStep;
    }

    drawPlaneGrid(image, cx, cy, radius, y + 6);
    drawCompassRose(image, cx, cy, radius, heading);
    return image;
  }

  // A tap opens calibration from either state: it is the affordance the
  // "Uncalibrated" prompt advertises, and re-calibrating is a normal thing to
  // want once the glasses have been taken off and put back on.
  handleInput(event: InputEvent, ctx: LayerContext): void {
    if (event.type === "click") this.openCalibration(ctx);
  }
}

export function createCompassAppWindow(options: InProcessAppOptions): InProcessWindow {
  let app: InProcessWindow;
  let requestRender = () => {};
  const layer = new CompassLayer(() => requestRender());
  app = createInProcessWindow({
    appId: "compass",
    windowId: COMPASS_WINDOW_ID,
    title: "Compass",
    iconLetter: "C",
    icon: "compass",
    closeable: true,
    actions: options.actions,
    menuItems: () => [
      {
        label: "Calibrate",
        onSelect: (ctx) => {
          ctx.stack.pop();
          layer.openCalibration(ctx);
        },
      },
    ],
    baseLayer: new YieldAtRootLayer(layer),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      layer.stop();
      options.onClosed();
    },
  });
  requestRender = app.requestRender;
  layer.start();
  return app;
}

function cardinalDirection(heading: number): string {
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return names[Math.round(normalizeHeading(heading) / 45) % names.length]!;
}

interface Point {
  x: number;
  y: number;
}

/**
 * Project a point of the rose's plane onto the screen. `angle` is degrees
 * clockwise from the far side of the disc — the direction the wearer faces —
 * and `radius` is a fraction of the rose's outer ring.
 */
function projectRose(cx: number, cy: number, scale: number, radius: number, angle: number): Point {
  const radians = (angle * Math.PI) / 180;
  const across = radius * Math.sin(radians);
  const away = radius * Math.cos(radians);
  const depth = 1 + TILT_PERSPECTIVE * away;
  return {
    x: cx + (across * scale) / depth,
    y: cy - (away * scale * TILT_SQUASH) / depth,
  };
}

/** Draw the tilted rose, with its brightest point aimed at magnetic north. */
function drawCompassRose(image: GrayImage, cx: number, cy: number, radius: number, heading: number | null): void {
  // Without a reading there is nothing to aim, so show the rose in its resting
  // orientation, dimmed, rather than an empty ring.
  const fade = heading === null ? 0.45 : 1;
  const bearing = heading ?? 0;
  drawDiscWall(image, cx, cy, radius, fade);
  drawTiltedRing(image, cx, cy, radius, 105 * fade);
  drawHeadingTick(image, cx, cy, radius, 255 * fade);
  // Short points first, so the long ones sit on top of them at the waist. Only
  // north is drawn at full brightness: the other seven are there to make the
  // rose read as a rose, and competing with north would defeat the point.
  for (const degrees of [45, 135, 225, 315]) {
    drawRosePoint(image, cx, cy, radius, degrees - bearing, INTERCARDINAL_TIP, 85 * fade, 40 * fade);
  }
  for (const degrees of [90, 180, 270]) {
    drawRosePoint(image, cx, cy, radius, degrees - bearing, CARDINAL_TIP, 120 * fade, 55 * fade);
  }
  drawRosePoint(image, cx, cy, radius, -bearing, CARDINAL_TIP, 255 * fade, 140 * fade);
}

/**
 * One point of the rose: a tapered spike split down its axis into a lit and a
 * shaded facet, which is what keeps the eight points readable once perspective
 * has squashed the ones lying across the wearer's line of sight.
 */
function drawRosePoint(
  image: GrayImage,
  cx: number,
  cy: number,
  radius: number,
  angle: number,
  tipRadius: number,
  litValue: number,
  shadedValue: number,
): void {
  const centre = { x: cx, y: cy };
  const tip = projectRose(cx, cy, radius, tipRadius, angle);
  const clockwise = projectRose(cx, cy, radius, POINT_BASE_RADIUS, angle + POINT_BASE_HALF_ANGLE);
  const anticlockwise = projectRose(cx, cy, radius, POINT_BASE_RADIUS, angle - POINT_BASE_HALF_ANGLE);
  fillTriangle(image, tip, centre, clockwise, litValue);
  fillTriangle(image, tip, centre, anticlockwise, shadedValue);
}

/**
 * The side wall below the wearer-facing arc of the rim, which turns the tilted
 * disc into a shallow cylinder. The arc runs between the two points where the
 * silhouette turns vertical, so the wall ends flush with that vertical edge,
 * and it is shaded from dark there to lit where it faces the wearer head-on.
 */
function drawDiscWall(image: GrayImage, cx: number, cy: number, radius: number, fade: number): void {
  const depth = discDepth(radius);
  const segments = 48;
  const sweep = 360 - WALL_START_ANGLE * 2;
  const rimValue = 105 * fade;
  let previous = projectRose(cx, cy, radius, 1, WALL_START_ANGLE);
  image.drawLine(previous.x, previous.y, previous.x, previous.y + depth, rimValue);
  for (let i = 1; i <= segments; i++) {
    const angle = WALL_START_ANGLE + (i * sweep) / segments;
    const point = projectRose(cx, cy, radius, 1, angle);
    // Quads rather than per-column lines, so no gap opens up where the rim
    // runs nearly horizontal across the bottom of the oval.
    const value = (WALL_DARK + (WALL_LIT - WALL_DARK) * wallFacing(angle)) * fade;
    const top = { x: previous.x, y: previous.y };
    const next = { x: point.x, y: point.y };
    fillTriangle(image, top, next, { x: next.x, y: next.y + depth }, value);
    fillTriangle(image, top, { x: top.x, y: top.y + depth }, { x: next.x, y: next.y + depth }, value);
    image.drawLine(top.x, top.y + depth, next.x, next.y + depth, rimValue);
    previous = point;
  }
  image.drawLine(previous.x, previous.y, previous.x, previous.y + depth, rimValue);
}

/** 1 where the wall faces the wearer head-on, 0 at the silhouette's edges. */
function wallFacing(angle: number): number {
  const towardWearer = -Math.cos((angle * Math.PI) / 180);
  return (towardWearer - TILT_PERSPECTIVE) / (1 - TILT_PERSPECTIVE);
}

/**
 * The grid the disc sits on, drawn before the disc so the disc occludes it.
 * Brightness falls off with distance and fades to nothing as the plane climbs
 * towards `clipY`, so the grid dissolves into the black under the readout
 * rather than stopping at a hard edge.
 */
function drawPlaneGrid(image: GrayImage, cx: number, cy: number, radius: number, clipY: number): void {
  const shade = (point: Point, ringRadius: number): number => {
    if (point.y > image.height || Math.abs(point.x - cx) > image.width) return 0;
    const fade = Math.max(0, Math.min(1, (point.y - clipY) / PLANE_FADE_SPAN));
    const value = (PLANE_NEAR_VALUE / (1 + PLANE_FALLOFF * (ringRadius - 1))) * fade;
    return value >= PLANE_CUTOFF ? value : 0;
  };
  const trace = (
    steps: number,
    at: (step: number) => { point: Point; ringRadius: number },
  ): void => {
    let previous: Point | null = null;
    let previousValue = 0;
    for (let i = 0; i <= steps; i++) {
      const { point, ringRadius } = at(i);
      const value = shade(point, ringRadius);
      if (previous !== null && previousValue > 0 && value > 0) {
        image.drawLine(previous.x, previous.y, point.x, point.y, (previousValue + value) / 2);
      }
      previous = point;
      previousValue = value;
    }
  };

  for (const ringRadius of PLANE_RINGS) {
    trace(96, (step) => ({ point: projectRose(cx, cy, radius, ringRadius, (step * 360) / 96), ringRadius }));
  }
  // Spokes run from just outside the disc to the outermost ring, so the grid
  // closes on itself instead of trailing off into loose ends.
  const outer = PLANE_RINGS[PLANE_RINGS.length - 1]!;
  for (let angle = PLANE_SPOKE_STEP / 2; angle < 360; angle += PLANE_SPOKE_STEP) {
    trace(24, (step) => {
      const ringRadius = 1.05 + (step * (outer - 1.05)) / 24;
      return { point: projectRose(cx, cy, radius, ringRadius, angle), ringRadius };
    });
  }
}

/** Screen depth of the disc's side wall at the given ring radius. */
function discDepth(radius: number): number {
  return Math.max(3, Math.round(radius * DISC_DEPTH));
}

/** The ring bounding the rose: the tilted disc's rim, drawn as a polygon. */
function drawTiltedRing(image: GrayImage, cx: number, cy: number, radius: number, value: number): void {
  const segments = 72;
  let previous = projectRose(cx, cy, radius, 1, 0);
  for (let i = 1; i <= segments; i++) {
    const point = projectRose(cx, cy, radius, 1, (i * 360) / segments);
    image.drawLine(previous.x, previous.y, point.x, point.y, value);
    previous = point;
  }
}

/** A fixed mark at the top of the ring: the heading the wearer is facing. */
function drawHeadingTick(image: GrayImage, cx: number, cy: number, radius: number, value: number): void {
  const top = projectRose(cx, cy, radius, 1, 0);
  fillTriangle(
    image,
    { x: cx, y: top.y - 1 },
    { x: cx - TICK_HALF_WIDTH, y: top.y - TICK_HEIGHT },
    { x: cx + TICK_HALF_WIDTH, y: top.y - TICK_HEIGHT },
    value,
  );
}

function fillTriangle(image: GrayImage, a: Point, b: Point, c: Point, value: number): void {
  const left = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
  const right = Math.min(image.width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const top = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const bottom = Math.min(image.height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  const shade = Math.round(value);
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const point = { x: x + 0.5, y: y + 0.5 };
      const ab = edge(a, b, point);
      const bc = edge(b, c, point);
      const ca = edge(c, a, point);
      // Accept either winding, so callers don't have to order their vertices.
      if ((ab >= 0 && bc >= 0 && ca >= 0) || (ab <= 0 && bc <= 0 && ca <= 0)) {
        image.setPixel(x, y, shade);
      }
    }
  }
}

/** Twice the signed area of the triangle a-b-p; its sign is p's side of a-b. */
function edge(a: Point, b: Point, p: Point): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}
