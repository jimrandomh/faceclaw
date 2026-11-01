import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { clamp } from "../../util/numeric-util";
import { GESTURE_DOUBLE_CLICK, type InputEvent } from "../../ui/gestures";
import { Layer, type LayerContext } from "../../ui/layers";
import { shell } from "../../ui/shell/shell";
import {
  MEMORY_SERIES,
  formatMb,
  sampleResourceUsage,
  type ResourceSample,
} from "../../native/resource-usage";

const SAMPLE_INTERVAL_MS = 1_000;
const HISTORY_MS = 60_000;
const MAX_SAMPLES = Math.ceil(HISTORY_MS / SAMPLE_INTERVAL_MS) + 2;
/** Line brightness per memory series, headline first. */
const MEMORY_SHADES = [240, 155, 80];

type ChartSample = ResourceSample & { cpuPercent: number };

type Series = {
  value: (sample: ChartSample) => number;
  shade: number;
};

/**
 * One-minute process monitor. Sampling deliberately continues while another
 * window is foreground so switching back reveals the resource cost of that
 * workload. Repaints remain visibility-gated to avoid creating hidden frames.
 * Which memory figures are charted is up to the platform (MEMORY_SERIES).
 */
export class ResourceUsageLayer implements Layer {
  private readonly samples: ChartSample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private removed = false;
  private previousElapsedMs = 0;
  private previousCpuMs = 0;
  private sampleError = "";

  constructor(
    private readonly windowId: string,
    private readonly requestRender: () => void,
  ) {
    this.takeSample();
    this.timer = setInterval(() => this.takeSample(), SAMPLE_INTERVAL_MS);
  }

  onRemoved(): void {
    this.removed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const latest = this.samples[this.samples.length - 1];

    image.drawText(font, 16, 5, "Resource usage — last minute", 230);
    if (!latest) {
      image.drawText(font, 16, 30, this.sampleError || "Waiting for first sample…", 170);
      image.drawText(font, 16, height - 16, `${GESTURE_DOUBLE_CLICK} back`, 110);
      return image;
    }

    const cpuText = `CPU ${formatPercent(latest.cpuPercent)}  ${latest.threads} threads`;
    image.drawText(font, width - 16 - font.measureText(cpuText), 5, cpuText, 200);
    image.drawText(font, 16, 21, this.sampleError || latest.status, this.sampleError ? 170 : 140);

    const memorySeries = MEMORY_SERIES.map((label, index) => ({
      label,
      shade: MEMORY_SHADES[index] ?? 80,
      value: (sample: ChartSample) => sample.memoryMb[index] ?? 0,
    }));
    const memoryPeak = Math.max(...this.samples.flatMap((sample) => sample.memoryMb), 64);
    const memoryScale = roundUp(memoryPeak * 1.08, 64);
    const legendLeft = drawLegend(
      image,
      font,
      width,
      48,
      memorySeries.map((series) => [`${series.label} ${formatMb(series.value(latest))}`, series.shade] as const),
    );
    const scaleLabel = `Memory 0–${formatMb(memoryScale)}`;
    const shortScaleLabel = `0–${formatMb(memoryScale)}`;
    image.drawText(
      font,
      16,
      48,
      16 + font.measureText(scaleLabel) + 8 <= legendLeft ? scaleLabel : shortScaleLabel,
      140,
    );
    drawChart(image, this.samples, latest.atMs, { x: 16, y: 64, width: width - 32, height: 70 }, memoryScale, memorySeries);

    const cpuPeak = Math.max(...this.samples.map((sample) => sample.cpuPercent), 100);
    const cpuScale = roundUp(cpuPeak * 1.08, 25);
    image.drawText(font, 16, 144, `CPU 0–${Math.round(cpuScale)}% (one core)`, 140);
    drawChart(image, this.samples, latest.atMs, { x: 16, y: 160, width: width - 32, height: 60 }, cpuScale, [
      { value: (sample) => sample.cpuPercent, shade: 220 },
    ]);

    image.drawText(font, 16, height - 16, `-60s`, 80);
    const nowLabel = `now`;
    image.drawText(font, width - 16 - font.measureText(nowLabel), height - 16, nowLabel, 110);
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") {
      ctx.stack.pop();
    }
  }

  private takeSample(): void {
    if (this.removed) return;
    try {
      const sample = sampleResourceUsage();
      const elapsedDelta = sample.atMs - this.previousElapsedMs;
      const cpuDelta = sample.cpuMs - this.previousCpuMs;
      const cpuPercent = this.previousElapsedMs > 0 && elapsedDelta > 0
        ? Math.max(0, cpuDelta / elapsedDelta * 100)
        : 0;
      this.previousElapsedMs = sample.atMs;
      this.previousCpuMs = sample.cpuMs;
      this.samples.push({ ...sample, cpuPercent });
      const cutoff = sample.atMs - HISTORY_MS;
      while (this.samples.length > 1 && this.samples[0]!.atMs < cutoff) this.samples.shift();
      while (this.samples.length > MAX_SAMPLES) this.samples.shift();
      this.sampleError = "";
    } catch (error) {
      this.sampleError = `Sampling failed: ${(error as Error)?.message ?? error}`;
    }
    if (shell.isWindowVisible(this.windowId)) {
      this.requestRender();
    }
  }
}

function drawChart(
  image: GrayImage,
  samples: readonly ChartSample[],
  nowMs: number,
  bounds: { x: number; y: number; width: number; height: number },
  scale: number,
  series: readonly Series[],
): void {
  image.drawRect(bounds.x, bounds.y, bounds.width, bounds.height, 45);
  const midY = bounds.y + Math.round((bounds.height - 1) / 2);
  image.drawLine(bounds.x + 1, midY, bounds.x + bounds.width - 2, midY, 24);
  const startMs = nowMs - HISTORY_MS;
  // Back to front, so the headline series is drawn on top where lines cross.
  for (const item of [...series].reverse()) {
    let previous: { x: number; y: number } | null = null;
    for (const sample of samples) {
      if (sample.atMs < startMs) continue;
      const x = bounds.x + Math.round(clamp((sample.atMs - startMs) / HISTORY_MS, 0, 1) * (bounds.width - 1));
      const y = bounds.y + bounds.height - 1
        - Math.round(clamp(item.value(sample) / Math.max(1, scale), 0, 1) * (bounds.height - 1));
      if (previous) image.drawLine(previous.x, previous.y, x, y, item.shade);
      else image.setPixel(x, y, item.shade);
      previous = { x, y };
    }
  }
}

/** Right-aligned legend of line swatches and labels; returns its left edge. */
function drawLegend(
  image: GrayImage,
  font: ReturnType<typeof getDefaultSmallFont>,
  width: number,
  y: number,
  entries: ReadonlyArray<readonly [string, number]>,
): number {
  const totalWidth = entries.reduce((sum, [label]) => sum + font.measureText(label) + 14, 0);
  const left = width - 16 - totalWidth;
  let x = left;
  for (const [label, shade] of entries) {
    image.drawLine(x, y + 6, x + 8, y + 6, shade);
    x += 12;
    image.drawText(font, x, y, label, shade);
    x += font.measureText(label) + 2;
  }
  return left;
}

function roundUp(value: number, step: number): number {
  return Math.max(step, Math.ceil(value / step) * step);
}

function formatPercent(value: number): string {
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}
