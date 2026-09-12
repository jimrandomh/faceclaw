/**
 * The phone graph view's BITMAP, built without touching the phone.
 *
 * Same split, and for the same reason, as `health-glance.ts` is split out of
 * the glasses app: `health-view-model.ts` owns the store reads, the measured
 * box, the fold class and the `ImageSource` conversion - all NativeScript - and
 * hands this file a size, a font and some already-selected data. What comes
 * back is a `GrayImage`.
 *
 * The payoff is that `tools/health-preview.cjs` can render the phone chart at
 * any width under plain node, which is how the narrow/wide layouts get checked
 * without an emulator. It also means the chart the preview shows is built by
 * the same function the phone calls, not a reimplementation of it.
 */

import { GrayImage, type UiFont } from "../graphics/image";
import {
  drawMetricChart,
  drawSleepLanes,
  drawSleepStackChart,
  INK,
} from "./health-chart";
import type { RollupPoint, SampleMetric, SleepNight } from "./health-types";
import type { SleepStageName } from "./sleep-stages";

/**
 * What to draw. Three shapes, because the redesign gave sleep two charts of
 * its own that are not "a series of numbers over time":
 *
 *   - `metric`   the five measured types, banded or barred (unchanged)
 *   - `nights`   sleep over a week/month/quarter: the diverging stacked bar
 *   - `lanes`    sleep over ONE day: the four stage lanes, which is the same
 *                view the glasses drill-down shows, so the two surfaces agree
 *                about what "sleep, today" looks like
 */
export type PhoneChartContent =
  | {
      kind: "metric";
      metric: SampleMetric;
      points: readonly RollupPoint[];
      mode: "band" | "bars";
      xLabel: (point: RollupPoint, index: number) => string;
    }
  | {
      kind: "nights";
      nights: readonly SleepNight[];
      xLabel: (night: SleepNight, index: number) => string;
    }
  | {
      kind: "lanes";
      bands: readonly { stage: SleepStageName | null; seconds: number }[];
      laneText: (stage: SleepStageName) => { label: string; value: string };
    };

export type PhoneChartRequest = {
  /** Pixels, already scaled by RENDER_SCALE. */
  width: number;
  height: number;
  font: UiFont;
  content: PhoneChartContent;
};

/** The inset between the bitmap's edge and the plot. */
const INSET = 8;

export function renderPhoneChart(request: PhoneChartRequest): GrayImage {
  const { width, height, font, content } = request;
  const image = new GrayImage(width, height, INK.background);
  const rect = {
    x: INSET,
    y: INSET,
    width: Math.max(8, width - INSET * 2),
    height: Math.max(8, height - INSET * 2),
  };

  switch (content.kind) {
    case "metric":
      drawMetricChart(image, rect, {
        metric: content.metric,
        points: content.points,
        font,
        mode: content.mode,
        xLabel: content.xLabel,
      });
      return image;
    case "nights":
      drawSleepStackChart(image, rect, {
        nights: content.nights,
        font,
        xLabel: content.xLabel,
      });
      return image;
    case "lanes":
      drawSleepLanes(image, rect, {
        bands: content.bands,
        font,
        laneText: content.laneText,
      });
      return image;
  }
}
