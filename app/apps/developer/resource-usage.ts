import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { clamp } from "../../util/numeric-util";
import { GESTURE_DOUBLE_CLICK, type InputEvent } from "../../ui/gestures";
import { Layer, type LayerContext } from "../../ui/layers";
import { shell } from "../../ui/shell/shell";

declare const com: any;

const SAMPLE_INTERVAL_MS = 1_000;
const HISTORY_MS = 60_000;
const MAX_SAMPLES = Math.ceil(HISTORY_MS / SAMPLE_INTERVAL_MS) + 2;

type ResourceSample = {
  atMs: number;
  rssMb: number;
  nativeMb: number;
  javaMb: number;
  javaCommittedMb: number;
  cpuPercent: number;
  threads: number;
};

type Series = {
  value: (sample: ResourceSample) => number;
  shade: number;
};

/**
 * One-minute process monitor. Sampling deliberately continues while another
 * window is foreground so switching back reveals the resource cost of that
 * workload. Repaints remain visibility-gated to avoid creating hidden frames.
 */
export class ResourceUsageLayer implements Layer {
  private readonly samples: ResourceSample[] = [];
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

    image.drawText(
      font,
      16,
      21,
      `RSS ${formatMb(latest.rssMb)}  native ${formatMb(latest.nativeMb)}  Java ${formatMb(latest.javaMb)}/${formatMb(latest.javaCommittedMb)}`,
      190,
    );
    image.drawText(
      font,
      width - 16 - font.measureText(`CPU ${formatPercent(latest.cpuPercent)}  threads ${latest.threads}`),
      47 - font.lineHeight,
      `CPU ${formatPercent(latest.cpuPercent)}  threads ${latest.threads}`,
      155,
    );

    const memoryPeak = Math.max(...this.samples.map((sample) => sample.rssMb), 64);
    const memoryScale = roundUp(memoryPeak * 1.08, 64);
    image.drawText(font, 16, 48, `Memory 0–${formatMb(memoryScale)}`, 140);
    drawLegend(image, font, width, 48, [
      ["RSS", 240],
      ["native", 155],
      ["Java", 80],
    ]);
    drawChart(image, this.samples, latest.atMs, { x: 16, y: 64, width: width - 32, height: 70 }, memoryScale, [
      { value: (sample) => sample.rssMb, shade: 240 },
      { value: (sample) => sample.nativeMb, shade: 155 },
      { value: (sample) => sample.javaMb, shade: 80 },
    ]);

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
      const raw = com.faceclaw.app.FaceclawResourceUsage.sample();
      const atMs = Number(raw[0]);
      const cpuMs = Number(raw[1]);
      const elapsedDelta = atMs - this.previousElapsedMs;
      const cpuDelta = cpuMs - this.previousCpuMs;
      const cpuPercent = this.previousElapsedMs > 0 && elapsedDelta > 0
        ? Math.max(0, cpuDelta / elapsedDelta * 100)
        : 0;
      this.previousElapsedMs = atMs;
      this.previousCpuMs = cpuMs;
      this.samples.push({
        atMs,
        cpuPercent,
        rssMb: kbToMb(Number(raw[2])),
        nativeMb: kbToMb(Number(raw[3])),
        javaMb: kbToMb(Number(raw[4])),
        javaCommittedMb: kbToMb(Number(raw[5])),
        threads: Number(raw[6]),
      });
      const cutoff = atMs - HISTORY_MS;
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
  samples: readonly ResourceSample[],
  nowMs: number,
  bounds: { x: number; y: number; width: number; height: number },
  scale: number,
  series: readonly Series[],
): void {
  image.drawRect(bounds.x, bounds.y, bounds.width, bounds.height, 45);
  const midY = bounds.y + Math.round((bounds.height - 1) / 2);
  image.drawLine(bounds.x + 1, midY, bounds.x + bounds.width - 2, midY, 24);
  const startMs = nowMs - HISTORY_MS;
  for (const item of series) {
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

function drawLegend(
  image: GrayImage,
  font: ReturnType<typeof getDefaultSmallFont>,
  width: number,
  y: number,
  entries: ReadonlyArray<readonly [string, number]>,
): void {
  const totalWidth = entries.reduce((sum, [label]) => sum + font.measureText(label) + 14, 0);
  let x = width - 16 - totalWidth;
  for (const [label, shade] of entries) {
    image.drawLine(x, y + 6, x + 8, y + 6, shade);
    x += 12;
    image.drawText(font, x, y, label, shade);
    x += font.measureText(label) + 2;
  }
}

function kbToMb(kb: number): number {
  return Math.max(0, kb) / 1024;
}

function roundUp(value: number, step: number): number {
  return Math.max(step, Math.ceil(value / step) * step);
}

function formatMb(value: number): string {
  if (value >= 1024) return `${(value / 1024).toFixed(1)}G`;
  return `${Math.round(value)}M`;
}

function formatPercent(value: number): string {
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}
