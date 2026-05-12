import { loadEmbeddedTerminus32 } from "../../graphics/bdffont";
import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { Layer, type DashboardInputEvent, type LayerContext } from "../layers";

const stopwatchFont = loadEmbeddedTerminus32();

export class StopwatchLayer implements Layer {
  private readonly startedAtMs = Date.now();
  private pausedAtMs: number | null = null;
  private pausedDurationMs = 0;

  paint(ctx: LayerContext): GrayImage {
    const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    const elapsedMs = this.elapsedMs();
    const timeLabel = formatStopwatchElapsed(elapsedMs);
    const stateLabel = this.pausedAtMs === null ? "Running" : "Paused";

    image.drawText(ctx.font, 24, 24, "Stopwatch", 180);

    const quadrantWidth = G2_LENS_WIDTH / 2;
    const quadrantHeight = G2_LENS_HEIGHT / 2;
    const timeX = Math.max(0, Math.round((quadrantWidth - stopwatchFont.measureText(timeLabel)) / 2));
    const timeY = Math.max(0, Math.round((quadrantHeight - stopwatchFont.lineHeight) / 2));
    image.drawText(stopwatchFont, timeX, timeY, timeLabel, 245);
    image.drawText(ctx.font, 90, 142, stateLabel, 150);
    image.drawText(ctx.font, 90, 160, "Click: pause / resume", 150);
    image.drawText(ctx.font, 90, 178, "Double-click: back", 150);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") {
      void ctx.actions.setStopwatchRenderActive(false);
      ctx.stack.pop();
      return;
    }
    if (event.type === "click") {
      if (this.pausedAtMs === null) {
        this.pausedAtMs = Date.now();
        void ctx.actions.setStopwatchRenderActive(false);
      } else {
        this.pausedDurationMs += Date.now() - this.pausedAtMs;
        this.pausedAtMs = null;
        void ctx.actions.setStopwatchRenderActive(true);
      }
    }
  }

  private elapsedMs(): number {
    const now = this.pausedAtMs ?? Date.now();
    return Math.max(0, now - this.startedAtMs - this.pausedDurationMs);
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatStopwatchElapsed(elapsedMs: number): string {
  const totalTenths = Math.floor(elapsedMs / 100);
  const tenths = totalTenths % 10;
  const totalSeconds = Math.floor(totalTenths / 10);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) {
    return `${hours}:${pad2(minutes)}:${pad2(seconds)}.${tenths}`;
  }
  return `${pad2(minutes)}:${pad2(seconds)}.${tenths}`;
}
