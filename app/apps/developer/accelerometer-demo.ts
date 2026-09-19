import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { clamp } from "../../util/numeric-util";
import { addImuListener, imuSourceLabel, setImuReportEnabled, type ImuReading } from "../../native/imu";
import { GESTURE_DOUBLE_CLICK, type InputEvent } from "../../ui/gestures";
import { Layer, type LayerContext } from "../../ui/layers";
import { shell } from "../../ui/shell/shell";

// IMU report pace. This is NOT a literal Hz — the firmware only accepts the
// ImuReportPace codes 100..1000 (step 100); the real delivery rate is
// device-defined. An out-of-range value makes the firmware stream empty
// (all-zero) samples. 200 matches the reference EvenHub running-tracker app.
const IMU_REPORT_PACE = 200;
// How often to reconcile the IMU on/off state with window visibility.
const RECONCILE_INTERVAL_MS = 400;

/**
 * Accelerometer demo: turns the IMU stream on while this page is visible (the
 * Developer window is foregrounded and the screen is on), off otherwise, and
 * shows the latest x/y/z reading with a simple per-axis bar.
 *
 * The IMU stream is experimental — the firmware may never populate it — so the
 * page also reports how many samples have arrived.
 */
export class AccelerometerDemoLayer implements Layer {
  private reading: ImuReading | null = null;
  private sampleCount = 0;
  private peak = 0;
  private enabled = false;
  private removed = false;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly windowId: string,
    private readonly requestRender: () => void,
  ) {
    this.start();
  }

  private start(): void {
    this.unsubscribe = addImuListener((reading) => {
      if (this.removed) return;
      this.reading = reading;
      this.sampleCount++;
      this.peak = Math.max(this.peak, Math.abs(reading.x), Math.abs(reading.y), Math.abs(reading.z));
      this.requestRender();
    });
    this.reconcileTimer = setInterval(() => this.reconcile(), RECONCILE_INTERVAL_MS);
    this.reconcile();
  }

  /** Match the IMU on/off state to whether this page is currently visible. */
  private reconcile(): void {
    if (this.removed) return;
    const visible = shell.isWindowVisible(this.windowId);
    if (visible === this.enabled) return;
    this.enabled = visible;
    setImuReportEnabled(visible, IMU_REPORT_PACE);
    this.requestRender();
  }

  onRemoved(): void {
    this.removed = true;
    if (this.reconcileTimer !== null) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.enabled) {
      setImuReportEnabled(false, IMU_REPORT_PACE);
      this.enabled = false;
    }
  }

  paint(ctx: LayerContext): GrayImage {
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);

    image.drawText(small, 20, 8, "Accelerometer", 220);
    const status = this.enabled ? "IMU on" : "IMU off";
    image.drawText(small, width - 20 - small.measureText(status), 8, status, 150);

    if (this.reading) {
      const axes: Array<[string, number]> = [
        ["X", this.reading.x],
        ["Y", this.reading.y],
        ["Z", this.reading.z],
      ];
      const barX = 118;
      const barW = width - barX - 24;
      const scale = Math.max(this.peak, 1e-6);
      let y = 40;
      for (const [label, value] of axes) {
        image.drawText(medium, 22, y, label, 210);
        image.drawText(medium, 44, y, value.toFixed(3), 235);
        drawCenteredBar(image, barX, y + 2, barW, 12, clamp(value / scale, -1, 1));
        y += 30;
      }
      image.drawText(
        small,
        22,
        y + 6,
        `source: ${imuSourceLabel(this.reading.source)}    samples: ${this.sampleCount}`,
        130,
      );
    } else {
      const message = this.enabled
        ? "Waiting for IMU data…"
        : "Paused (page not visible).";
      image.drawText(small, 22, 44, message, 190);
      image.drawText(small, 22, 66, "The firmware may not report the", 120);
      image.drawText(small, 22, 82, "accelerometer at all — experimental.", 120);
    }

    return image;
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    if (event.type === "double-click") {
      ctx.stack.pop();
    }
  }
}

/** Horizontal bar centered at its midpoint; frac in [-1, 1] fills left/right. */
function drawCenteredBar(image: GrayImage, x: number, y: number, width: number, height: number, frac: number): void {
  const mid = x + Math.round(width / 2);
  image.fillRect(x, y, width, height, 20);
  image.setPixel(mid, y - 1, 90);
  image.setPixel(mid, y + height, 90);
  const half = width / 2;
  const px = Math.round(clamp(frac, -1, 1) * half);
  if (px >= 0) {
    image.fillRect(mid, y, Math.max(1, px), height, 200);
  } else {
    image.fillRect(mid + px, y, -px, height, 200);
  }
}
