import { type GrayImage } from "../../../graphics/image";
import { getDefaultLargeFont, getDefaultSmallFont } from "../../../graphics/ui-fonts";
import { truncateText } from "../../../graphics/textwrap";
import { nightscoutBridge, type NightscoutState } from "../../../native/nightscout-bridge";
import { isNightscoutSettingsConfigured } from "../../../ui/dashboard-settings";
import { lineStep } from "../../../ui/metrics";
import { formatAgeShortFromTimestamp } from "~/util/date-util";
import {
  drawDirectionIndicator,
  drawNightscoutGraph,
  drawNightscoutValueStrikeThrough,
  formatDelta,
  isNightscoutPointStale,
} from "../../nightscout/nightscout";
import { type GlanceWidget } from "../widget";

const PAD = 8;
/** Width of the readout column left of the graph. */
const READOUT_WIDTH = 96;

/**
 * Current glucose with delta, trend and age beside the Nightscout app's
 * 2-hour graph. The bridge polls on its own for the whole session, so the
 * widget only subscribes; a minute tick keeps the age and staleness moving
 * during a stalled fetch.
 */
export class NightscoutWidget implements GlanceWidget {
  private state: NightscoutState = nightscoutBridge.snapshot();
  private unsubscribe: (() => void) | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;

  start(requestRender: () => void): void {
    this.unsubscribe = nightscoutBridge.onStateChange((state) => {
      this.state = state;
      requestRender();
    });
    this.tick = setInterval(requestRender, 60_000);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.tick !== null) clearInterval(this.tick);
    this.tick = null;
  }

  paint(image: GrayImage): void {
    const small = getDefaultSmallFont();
    const large = getDefaultLargeFont();
    const state = this.state;
    const nowMs = Date.now();
    const step = lineStep(small);
    image.drawText(small, PAD, PAD, "Nightscout", 150);

    if (!isNightscoutSettingsConfigured() || state.configurationMissing) {
      image.drawText(small, PAD, PAD + step + 4, "Not configured", 140);
      image.drawText(small, PAD, PAD + 2 * step + 4, "Set the site URL in the Nightscout app", 100);
      return;
    }
    const latest = state.latest;
    if (!state.available || !latest) {
      image.drawText(small, PAD, PAD + step + 4, "No data", 140);
      image.drawText(small, PAD, PAD + 2 * step + 4, truncateText(small, state.status, image.width - 2 * PAD), 100);
      return;
    }

    // Readout column: big value, units, then delta + trend and the age.
    const glucoseText = `${latest.sgv}`;
    const glucoseY = PAD + step;
    const glucoseWidth = large.measureText(glucoseText);
    image.drawText(large, PAD, glucoseY, glucoseText, 230);
    if (isNightscoutPointStale(latest, nowMs)) {
      drawNightscoutValueStrikeThrough(image, PAD, glucoseY + (large.lineHeight >> 1), glucoseWidth);
    }
    const unitsX = PAD + glucoseWidth + 4;
    if (unitsX + small.measureText(state.units) <= PAD + READOUT_WIDTH) {
      image.drawText(small, unitsX, glucoseY + large.lineHeight - small.lineHeight, state.units, 140);
    }
    let y = glucoseY + large.lineHeight + 2;
    const deltaText = `${formatDelta(state.delta)} `;
    image.drawText(small, PAD, y, deltaText, 180);
    drawDirectionIndicator(image, small, PAD + small.measureText(deltaText), y, state.direction, 180);
    y += step;
    image.drawText(small, PAD, y, `${formatAgeShortFromTimestamp(latest.timestampMs, nowMs)} ago`, 130);

    const graphX = PAD + READOUT_WIDTH + PAD;
    drawNightscoutGraph(
      image,
      { x: graphX, y: PAD, width: image.width - graphX - PAD, height: image.height - 2 * PAD },
      state,
      nowMs,
      small,
    );
  }
}
