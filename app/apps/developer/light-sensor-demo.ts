import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { clamp } from "../../util/numeric-util";
import {
  addAmbientLightListener,
  queryAmbientLight,
  setAmbientLightPolling,
  type AmbientLightReport,
} from "../../native/ambient-light";
import { GESTURE_DOUBLE_CLICK, type InputEvent } from "../../ui/gestures";
import { Layer, type LayerContext } from "../../ui/layers";
import { shell } from "../../ui/shell/shell";

// Passive poll period requested from the firmware (it clamps to 100..5000 ms).
const POLL_INTERVAL_MS = 250;
// Report every poll (min delta 0) so the trace shows the raw reading; the
// heartbeat only matters if the firmware ever starts filtering.
const POLL_MIN_DELTA = 0;
const POLL_HEARTBEAT_MS = 1_000;
// How often to reconcile the polling on/off state with window visibility.
const RECONCILE_INTERVAL_MS = 400;
// Length of the on-screen trace.
const HISTORY_MS = 30_000;
const MAX_SAMPLES = Math.ceil(HISTORY_MS / 100) + 2;

type Sample = { atMs: number; value: number; peak: number };

/**
 * Light sensor demo: turns CFW passive light-sensor polling (mode 16) on while
 * this page is visible and off otherwise, and shows the latest OPT3001
 * reading, the stock driver's peak/target, and a 30 s trace.
 *
 * While passive polling is on the stock auto-brightness adjuster does not step
 * the panel, so the level shown here stays wherever it was set. Leaving the
 * page hands the sensor back to the stock firmware.
 */
export class LightSensorDemoLayer implements Layer {
  private report: AmbientLightReport | null = null;
  private readonly samples: Sample[] = [];
  private reportCount = 0;
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
    this.unsubscribe = addAmbientLightListener((report) => {
      if (this.removed) return;
      this.report = report;
      this.reportCount++;
      const atMs = Date.now();
      if (report.readOk || !report.passive) {
        this.samples.push({ atMs, value: report.alsValue, peak: report.peak });
        const cutoff = atMs - HISTORY_MS;
        while (this.samples.length > 1 && this.samples[0]!.atMs < cutoff) this.samples.shift();
        while (this.samples.length > MAX_SAMPLES) this.samples.shift();
      }
      this.requestRender();
    });
    // Show whatever the driver currently holds before polling has started.
    queryAmbientLight();
    this.reconcileTimer = setInterval(() => this.reconcile(), RECONCILE_INTERVAL_MS);
    this.reconcile();
  }

  /** Match the polling on/off state to whether this page is currently visible. */
  private reconcile(): void {
    if (this.removed) return;
    const visible = shell.isWindowVisible(this.windowId);
    if (visible === this.enabled) return;
    this.enabled = visible;
    setAmbientLightPolling(visible, {
      intervalMs: POLL_INTERVAL_MS,
      minDelta: POLL_MIN_DELTA,
      heartbeatMs: POLL_HEARTBEAT_MS,
      bindToLease: true,
    });
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
      setAmbientLightPolling(false);
      this.enabled = false;
    }
  }

  paint(ctx: LayerContext): GrayImage {
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);

    image.drawText(small, 20, 8, "Light sensor", 220);
    const status = this.enabled ? "polling" : "paused";
    image.drawText(small, width - 20 - small.measureText(status), 8, status, 150);

    const report = this.report;
    if (!report) {
      const message = this.enabled ? "Waiting for a report…" : "Paused (page not visible).";
      image.drawText(small, 22, 44, message, 190);
      image.drawText(small, 22, 66, "Needs custom firmware with the als16", 120);
      image.drawText(small, 22, 82, "extension (EVENCFW/18 or newer).", 120);
      image.drawText(small, 20, height - 16, `${GESTURE_DOUBLE_CLICK} back`, 110);
      return image;
    }

    // Headline reading. The stock driver's unit is roughly a tenth of a lux.
    const lux = (report.alsValue / 10).toFixed(1);
    image.drawText(medium, 22, 30, `${lux} lux`, 245);
    const peakText = `peak ${(report.peak / 10).toFixed(1)}`;
    image.drawText(small, 22 + medium.measureText(`${lux} lux`) + 14, 36, peakText, 170);

    const flags: string[] = [];
    if (!report.opened) flags.push("sensor closed");
    if (report.passive) flags.push("passive");
    if (report.autoBrightness) flags.push("auto on");
    if (report.passive && !report.readOk) flags.push("read failed");
    image.drawText(small, 22, 58, flags.join("  ") || "stock polling", 150);

    image.drawText(
      small,
      22,
      76,
      `brightness ${report.brightness}   stock target ${report.stockTarget}   gear ${report.gear}   scale ${(report.scaleQ10 / 1024).toFixed(2)}`,
      170,
    );

    // 30 s trace of the reading (bright) and the driver's 5-sample peak (dim).
    // The axis label sits between the stats line and the chart, so the chart
    // starts a full text line lower than the stats.
    const chartTop = 76 + small.lineHeight * 2 + 4;
    const bounds = { x: 20, y: chartTop, width: width - 40, height: height - chartTop - 34 };
    const maxValue = Math.max(...this.samples.map((sample) => Math.max(sample.value, sample.peak)), 10);
    const scale = roundUpScale(maxValue * 1.08);
    image.drawText(small, bounds.x, bounds.y - small.lineHeight - 2, `0–${(scale / 10).toFixed(0)} lux, last 30 s`, 120);
    drawTrace(image, this.samples, Date.now(), bounds, scale);

    image.drawText(small, 20, height - 16, `reports: ${this.reportCount}`, 110);
    const back = `${GESTURE_DOUBLE_CLICK} back`;
    image.drawText(small, width - 20 - small.measureText(back), height - 16, back, 110);
    return image;
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    if (event.type === "double-click") {
      ctx.stack.pop();
    }
  }
}

/** Round a trace ceiling up to 1/2/5 × 10^n so the axis label stays tidy. */
function roundUpScale(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(value, 1)));
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

function drawTrace(
  image: GrayImage,
  samples: readonly Sample[],
  nowMs: number,
  bounds: { x: number; y: number; width: number; height: number },
  scale: number,
): void {
  image.drawRect(bounds.x, bounds.y, bounds.width, bounds.height, 45);
  const startMs = nowMs - HISTORY_MS;
  const series: Array<[(sample: Sample) => number, number]> = [
    [(sample) => sample.peak, 90],
    [(sample) => sample.value, 235],
  ];
  for (const [value, shade] of series) {
    let previous: { x: number; y: number } | null = null;
    for (const sample of samples) {
      if (sample.atMs < startMs) continue;
      const x = bounds.x + Math.round(clamp((sample.atMs - startMs) / HISTORY_MS, 0, 1) * (bounds.width - 1));
      const y = bounds.y + bounds.height - 1 - Math.round(clamp(value(sample) / scale, 0, 1) * (bounds.height - 1));
      if (previous) image.drawLine(previous.x, previous.y, x, y, shade);
      else image.setPixel(x, y, shade);
      previous = { x, y };
    }
  }
}
