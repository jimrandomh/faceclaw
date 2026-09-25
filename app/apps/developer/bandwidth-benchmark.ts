import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { Layer, type LayerContext } from "../../ui/layers";
import { type InputEvent } from "../../ui/gestures";
import { Menu, type MenuDrawArgs } from "../../ui/menu-core";
import { centeredTextY, tightRowHeight } from "../../ui/metrics";
import {
  cancelBandwidthBenchmark,
  getBandwidthBenchmarkStatus,
  startBandwidthBenchmark,
  type BandwidthBenchmarkStatus,
} from "../../native/bandwidth-benchmark";

const MESSAGE_SIZES = [250, 500, 1000, 2000, 3800];
const WINDOW_SIZES = [1, 2, 3, 4, 6];
const LINK_MODES = ["Current", "Request HIGH", "Request 2M", "HIGH + 2M"];
const DURATION_MS = 15_000;
// After painting the "running" screen, wait for that frame to reach the
// glasses before the benchmark blocks normal image sends — otherwise the
// status frame would sit queued behind the whole 15-second run.
const ARM_DELAY_MS = 800;
const POLL_INTERVAL_MS = 500;
// Give up polling if the run somehow never reports done (duration + ack
// timeout drain + slack).
const POLL_DEADLINE_MS = DURATION_MS + 15_000;

const HEADER_HEIGHT = 30;
const LIST_X = 20;
const VALUE_X = 150;

type Phase = "config" | "arming" | "running" | "done";
type ConfigRow = "size" | "window" | "link" | "start";

/**
 * BLE bandwidth benchmark: pick a message size and pipeline window, stream
 * no-op image payloads for 15 seconds, and report throughput. The glasses
 * screen is intentionally static while the run is active — the benchmark
 * stream is the only image traffic, so the numbers are clean.
 */
export class BandwidthBenchmarkLayer implements Layer {
  private phase: Phase = "config";
  private readonly menu = new Menu<ConfigRow>({
    items: ["size", "window", "link", "start"],
    wrap: false,
    rowGap: 1,
    highlight: { radius: 4 },
    getHeight: () => tightRowHeight(getDefaultSmallFont()) + 4,
    draw: (args) => this.drawRow(args),
  });
  private sizeIndex = 2;
  private windowIndex = 2;
  private linkModeIndex = 0;
  private result: BandwidthBenchmarkStatus | null = null;
  private error: string | null = null;
  private armTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollStartedAtMs = 0;

  constructor(private readonly requestRender: () => void) {}

  onRemoved(): void {
    this.clearTimers();
    if (this.phase === "arming" || this.phase === "running") {
      cancelBandwidthBenchmark();
    }
  }

  private clearTimers(): void {
    if (this.armTimer !== null) {
      clearTimeout(this.armTimer);
      this.armTimer = null;
    }
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private startRun(): void {
    this.result = null;
    this.error = null;
    this.phase = "arming";
    this.requestRender();
    this.armTimer = setTimeout(() => {
      this.armTimer = null;
      const started = startBandwidthBenchmark(
        MESSAGE_SIZES[this.sizeIndex]!,
        WINDOW_SIZES[this.windowIndex]!,
        DURATION_MS,
        this.linkModeIndex,
      );
      if (!started) {
        this.phase = "config";
        this.error = "Could not start (not connected?)";
        this.requestRender();
        return;
      }
      this.phase = "running";
      this.pollStartedAtMs = Date.now();
      // No renders while polling: a repaint would queue an image update that
      // stays blocked behind the benchmark anyway. Render once on completion.
      this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    }, ARM_DELAY_MS);
  }

  private poll(): void {
    const status = getBandwidthBenchmarkStatus();
    if (status && (status.state === "starting" || status.state === "running")) {
      if (Date.now() - this.pollStartedAtMs < POLL_DEADLINE_MS) return;
      cancelBandwidthBenchmark();
      return; // next poll picks up the cancelled run's "done"
    }
    this.clearTimers();
    if (status && status.state === "done") {
      this.result = status;
      this.phase = "done";
    } else {
      this.phase = "config";
      this.error = "Benchmark lost (disconnected?)";
    }
    this.requestRender();
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);

    image.drawText(font, 20, 8, "BLE bandwidth", 220);

    if (this.phase === "arming" || this.phase === "running") {
      image.drawText(font, LIST_X, HEADER_HEIGHT + 8, "Running: streaming no-op packets for 15 s...", 200);
      image.drawText(
        font,
        LIST_X,
        HEADER_HEIGHT + 30,
        `${MESSAGE_SIZES[this.sizeIndex]} B, window ${WINDOW_SIZES[this.windowIndex]}, ${LINK_MODES[this.linkModeIndex]}`,
        150,
      );
      image.drawText(font, LIST_X, HEADER_HEIGHT + 52, "Display updates pause until the run finishes.", 110);
      return image;
    }

    const rowH = tightRowHeight(font) + 4;
    const rowCount = this.menu.items.length;
    this.menu.paint(
      image,
      { x: LIST_X - 6, y: HEADER_HEIGHT - 1, width: width - 2 * LIST_X + 12, height: rowCount * rowH },
      ctx.stack.isFocused(),
    );

    let y = HEADER_HEIGHT + rowCount * rowH + 10;
    if (this.error) {
      image.drawText(font, LIST_X, y, this.error, 180);
    } else if (this.result) {
      const r = this.result;
      const seconds = r.elapsedMs / 1000;
      const payloadRate = seconds > 0 ? r.payloadBytesAcked / seconds : 0;
      const wireRate = seconds > 0 ? r.wireBytesAcked / seconds : 0;
      const lines = [
        `Throughput: ${(payloadRate / 1024).toFixed(2)} KB/s payload (${(wireRate / 1024).toFixed(2)} KB/s wire)`,
        `Messages: ${r.messagesAcked}/${r.messagesSent} acked, ${r.timeouts} timeouts`,
        `Elapsed: ${seconds.toFixed(1)} s` + (r.aborted ? "  (aborted early)" : ""),
        `Link request: ${LINK_MODES[r.linkMode] ?? "Current"}`,
      ];
      for (const line of lines) {
        image.drawText(font, LIST_X, y, line, 190);
        y += 20;
      }
    }

    return image;
  }

  private drawRow({ image, item, x, y, height, selected }: MenuDrawArgs<ConfigRow>): void {
    const font = getDefaultSmallFont();
    const [label, value]: [string, string] =
      item === "size" ? ["Message size", `${MESSAGE_SIZES[this.sizeIndex]} B`]
      : item === "window" ? ["Window size", `${WINDOW_SIZES[this.windowIndex]}`]
      : item === "link" ? ["Link request", LINK_MODES[this.linkModeIndex]!]
      : [this.phase === "done" ? "Run again" : "Start", ""];
    const textY = centeredTextY(font, y, height);
    // Text sits 6px in from the row box (LIST_X), values at VALUE_X.
    image.drawText(font, x + 6, textY, label, selected ? 255 : 200);
    if (value) {
      image.drawText(font, x + 6 + VALUE_X - LIST_X, textY, value, selected ? 235 : 160);
    }
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    if (this.phase === "arming" || this.phase === "running") {
      // A static screen during the run: only allow bailing out.
      if (event.type === "double-click") {
        ctx.stack.pop();
      }
      return;
    }
    switch (event.type) {
      case "scroll-up":
      case "scroll-down":
        await this.menu.handleInput(event);
        return;
      case "click": {
        const row = this.menu.selectedItem;
        if (row === "size") {
          this.sizeIndex = (this.sizeIndex + 1) % MESSAGE_SIZES.length;
        } else if (row === "window") {
          this.windowIndex = (this.windowIndex + 1) % WINDOW_SIZES.length;
        } else if (row === "link") {
          this.linkModeIndex = (this.linkModeIndex + 1) % LINK_MODES.length;
        } else if (row === "start") {
          this.startRun();
        }
        return;
      }
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }
}
