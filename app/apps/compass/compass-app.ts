import { getDefaultLargeFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import {
  COMPASS_CALIBRATION_COMPLETE,
  COMPASS_CALIBRATION_STARTED,
  COMPASS_CHANGED,
  addCompassListener,
  setCompassEnabled,
  type CompassEvent,
  type CompassDiagnostics,
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
import { ensureLocationPermission, hasLocationPermission } from "../../g2/android-permissions";
import { isCompassCalibrated, normalizeHeading } from "./calibration";
import { cardinalDirection, createCompassBackground, drawCompassRose, layoutCompassRose, TICK_HEIGHT } from "./compass-rose";
import { CompassCalibrationLayer } from "./calibration-layer";
import { getDeclinationAvailability, onDeclinationChanged, refreshDeclination } from "./declination";
import { getNorthReference, resolveHeading, setNorthReference, type NorthReference } from "./heading";
import { compassDebugLines, isCompassDebugEnabled, setCompassDebugEnabled } from "./debug";

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


class CompassLayer implements Layer {
  private rawHeading: number | null = null;
  private diagnostics: CompassDiagnostics | null = null;
  /** A firmware calibration message, shown until the next heading arrives. */
  private firmwareStatus: string | null = null;
  private enabled = false;
  private removed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeDeclination: (() => void) | null = null;
  private requestingPermission = false;
  private background: { key: string; image: GrayImage } | null = null;

  constructor(private readonly requestRender: () => void) {}

  start(): void {
    this.unsubscribe = addCompassListener((event) => this.onCompassEvent(event));
    this.unsubscribeDeclination = onDeclinationChanged(() => this.requestRender());
    this.timer = setInterval(() => this.reconcile(), RECONCILE_INTERVAL_MS);
    this.reconcile();
    this.ensureDeclination();
  }

  /**
   * True north needs the phone's location. Ask for it the way Weather does,
   * on opening, but only while the wearer actually wants true north: a
   * magnetic-mode compass has no business raising a permission prompt.
   */
  private ensureDeclination(): void {
    if (getNorthReference() !== "true") return;
    if (hasLocationPermission()) {
      refreshDeclination();
      return;
    }
    if (this.requestingPermission) return;
    this.requestingPermission = true;
    void ensureLocationPermission().then((granted) => {
      this.requestingPermission = false;
      if (granted) refreshDeclination();
      this.requestRender();
    });
  }

  toggleNorthReference(): void {
    setNorthReference(getNorthReference() === "true" ? "magnetic" : "true");
    this.ensureDeclination();
    this.requestRender();
  }

  toggleDebugInfo(): void {
    setCompassDebugEnabled(!isCompassDebugEnabled());
    this.requestRender();
  }

  stop(): void {
    if (this.removed) return;
    this.removed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeDeclination?.();
    this.unsubscribeDeclination = null;
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
    this.diagnostics = null;
    setCompassEnabled(visible);
    this.firmwareStatus = null;
    // The stored fix may have aged out while the compass was hidden.
    if (visible && hasLocationPermission()) refreshDeclination();
    this.requestRender();
  }

  private onCompassEvent(event: CompassEvent): void {
    if (this.removed) return;
    if (event.command === COMPASS_CHANGED && event.headingDegrees >= 0) {
      this.rawHeading = normalizeHeading(event.headingDegrees);
      this.diagnostics = event.diagnostics ?? null;
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
    if (!isCompassCalibrated()) return "Uncalibrated - Tap to calibrate";
    return frameStatusText();
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const small = getDefaultSmallFont();
    const large = getDefaultLargeFont();
    const heading = this.rawHeading === null ? null : resolveHeading(this.rawHeading).displayDegrees;
    const headingText = heading === null ? "--°" : `${Math.round(heading)}° ${cardinalDirection(heading)}`;
    const statusLines = wrapText(small, this.statusText(), width - STACK_GAP * 2);
    const smallStep = lineStep(small);
    const debugLines = isCompassDebugEnabled() ? compassDebugLines(this.diagnostics) : [];
    const debugWidth = Math.max(0, ...debugLines.map((line) => small.measureText(line)));
    const debugGap = debugLines.length ? 12 : 0;
    // Keep diagnostics beside the heading even in narrow windows. The rose
    // stays centred on the optical axis; the combined readout fits the viewport.
    const headingFont = large.measureText(headingText) + debugGap + debugWidth <= width - EDGE_PAD * 2
      ? large : small;
    const headingWidth = headingFont.measureText(headingText);
    const readoutWidth = headingWidth + debugGap + debugWidth;
    const debugHeight = debugLines.length ? (debugLines.length - 1) * smallStep + small.lineHeight : 0;
    const readoutHeight = Math.max(headingFont.lineHeight, debugHeight);

    // One column centred on the display's true centre, so the rose sits where
    // the wearer is looking rather than 32px right of it.
    const cx = screenCenterInViewportX();

    // The rose is sized and placed first — it hangs off the bottom edge — and
    // the readout then floats in whatever room is left above it.
    const textHeight = readoutHeight + 4 + statusLines.length * smallStep;
    const { cy, radius, ringTop } = layoutCompassRose({
      width,
      height,
      cx,
      topClearance: TOP_PAD + textHeight + STACK_GAP,
      bottomPad: BOTTOM_PAD,
      edgePad: EDGE_PAD,
      maxRadius: MAX_ROSE_RADIUS,
    });

    let y = Math.max(TOP_PAD, Math.round((ringTop - TICK_HEIGHT - textHeight) / 2));
    const fade = heading === null ? 0.45 : 1;
    const clipY = y + textHeight + 6;
    const backgroundKey = [width, height, cx, cy, radius, clipY, fade].join(",");
    if (this.background?.key !== backgroundKey) {
      this.background = {
        key: backgroundKey,
        image: createCompassBackground(width, height, cx, cy, radius, clipY, fade),
      };
    }
    const image = this.background.image.clone();
    drawCompassRose(image, cx, cy, radius, heading);
    const readoutX = Math.round(Math.max(EDGE_PAD, Math.min(width - EDGE_PAD - readoutWidth, cx - readoutWidth / 2)));
    image.drawText(headingFont, readoutX, y + Math.floor((readoutHeight - headingFont.lineHeight) / 2),
      headingText, heading === null ? 150 : 255);
    for (let i = 0; i < debugLines.length; i++) {
      image.drawText(small, readoutX + headingWidth + debugGap,
        y + Math.floor((readoutHeight - debugHeight) / 2) + i * smallStep, debugLines[i]!, 175);
    }
    y += readoutHeight + 4;
    for (const line of statusLines) {
      image.drawText(small, Math.round(cx - small.measureText(line) / 2), y, line, 125);
      y += smallStep;
    }

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
      {
        label: `North: ${northReferenceName(getNorthReference())}`,
        description: "True north is what maps use. Magnetic north matches a handheld compass; it needs no location.",
        onSelect: (ctx) => {
          ctx.stack.pop();
          layer.toggleNorthReference();
        },
      },
      {
        label: `Debug information: ${isCompassDebugEnabled() ? "On" : "Off"}`,
        description: "Show magnetic accuracy (0–3), anomaly flags (0–2), and orientation source beside the heading.",
        onSelect: (ctx) => {
          ctx.stack.pop();
          layer.toggleDebugInfo();
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

export function northReferenceName(reference: NorthReference): string {
  return reference === "true" ? "True" : "Magnetic";
}

/**
 * Name the frame the readout is in. When the wearer wants true north but the
 * phone can't supply declination, say that the reading is magnetic and why,
 * rather than quietly showing a magnetic heading under a "true" label.
 */
function frameStatusText(): string {
  if (getNorthReference() === "magnetic") return "Magnetic heading";
  switch (getDeclinationAvailability()) {
    case "available":
      return "True heading";
    case "no-permission":
      return "Magnetic heading - location permission needed for true north";
    case "no-fix":
      return "Magnetic heading - waiting for location";
  }
}
