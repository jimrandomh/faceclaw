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
/** The charts' heights where the window has room for them. */
const MEMORY_CHART_HEIGHT = 70;
const CPU_CHART_HEIGHT = 60;
/** Between the charts: a gap, then the CPU chart's label line. */
const CHART_GAP = 10;
const CHART_LABEL_HEIGHT = 16;
/** Least gap between the CPU chart and the footer line. */
const CHART_FOOTER_GAP = 4;

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
    const { width, height, padding } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const latest = this.samples[this.samples.length - 1];
    // The title line, the charts and the footer line span the window inside
    // the padding suggested for its edges; the rest is placed from the top.
    const left = padding.left;
    const top = padding.top;
    const right = width - padding.right;
    const footerY = height - padding.bottom - font.lineHeight;

    image.drawText(font, left, top, "Resource usage — last minute", 230);
    if (!latest) {
      image.drawText(font, left, top + 25, this.sampleError || "Waiting for first sample…", 170);
      image.drawText(font, left, footerY, `${GESTURE_DOUBLE_CLICK} back`, 110);
      return image;
    }

    const cpuText = `CPU ${formatPercent(latest.cpuPercent)}  ${latest.threads} threads`;
    image.drawText(font, right - font.measureText(cpuText), top, cpuText, 200);
    image.drawText(font, left, top + 16, this.sampleError || latest.status, this.sampleError ? 170 : 140);

    const memorySeries = MEMORY_SERIES.map((label, index) => ({
      label,
      shade: MEMORY_SHADES[index] ?? 80,
      value: (sample: ChartSample) => sample.memoryMb[index] ?? 0,
    }));
    const memoryPeak = Math.max(...this.samples.flatMap((sample) => sample.memoryMb), 64);
    const memoryScale = roundUp(memoryPeak * 1.08, 64);
    const legendY = top + 43;
    const legendLeft = drawLegend(
      image,
      font,
      right,
      legendY,
      memorySeries.map((series) => [`${series.label} ${formatMb(series.value(latest))}`, series.shade] as const),
    );
    const scaleLabel = `Memory 0–${formatMb(memoryScale)}`;
    const shortScaleLabel = `0–${formatMb(memoryScale)}`;
    image.drawText(
      font,
      left,
      legendY,
      left + font.measureText(scaleLabel) + 8 <= legendLeft ? scaleLabel : shortScaleLabel,
      140,
    );
    // The charts shrink together where the window is too short for both
    // above the footer line (the RayNeo iO's).
    const chartsTop = legendY + CHART_LABEL_HEIGHT;
    const room = footerY - CHART_FOOTER_GAP - chartsTop - CHART_GAP - CHART_LABEL_HEIGHT;
    const fit = clamp(room / (MEMORY_CHART_HEIGHT + CPU_CHART_HEIGHT), 0, 1);
    const memoryHeight = Math.floor(MEMORY_CHART_HEIGHT * fit);
    const chartWidth = Math.max(0, right - left);
    drawChart(image, this.samples, latest.atMs, { x: left, y: chartsTop, width: chartWidth, height: memoryHeight }, memoryScale, memorySeries);

    const cpuPeak = Math.max(...this.samples.map((sample) => sample.cpuPercent), 100);
    const cpuScale = roundUp(cpuPeak * 1.08, 25);
    const cpuLabelY = chartsTop + memoryHeight + CHART_GAP;
    image.drawText(font, left, cpuLabelY, `CPU 0–${Math.round(cpuScale)}% (one core)`, 140);
    drawChart(image, this.samples, latest.atMs,
      { x: left, y: cpuLabelY + CHART_LABEL_HEIGHT, width: chartWidth, height: Math.floor(CPU_CHART_HEIGHT * fit) }, cpuScale, [
        { value: (sample) => sample.cpuPercent, shade: 220 },
      ]);

    image.drawText(font, left, footerY, `-60s`, 80);
    const nowLabel = `now`;
    image.drawText(font, right - font.measureText(nowLabel), footerY, nowLabel, 110);
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
  if (bounds.width < 2 || bounds.height < 2) return;
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

/** Legend of line swatches and labels, right-aligned to end at `right`; returns its left edge. */
function drawLegend(
  image: GrayImage,
  font: ReturnType<typeof getDefaultSmallFont>,
  right: number,
  y: number,
  entries: ReadonlyArray<readonly [string, number]>,
): number {
  const totalWidth = entries.reduce((sum, [label]) => sum + font.measureText(label) + 14, 0);
  const left = right - totalWidth;
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
