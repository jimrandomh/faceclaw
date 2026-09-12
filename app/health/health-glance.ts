/**
 * HEALTH, the glasses surface - all of its DRAWING, and none of its plumbing.
 *
 * ## Why this is a separate file from `apps/health/health-app.ts`
 *
 * The app file owns the things only a running app can do: reading the store,
 * the refresh timer, the input cursor, the window lifecycle. All of that needs
 * NativeScript. The drawing needs nothing but a `GrayImage` and two fonts.
 *
 * Splitting them the way `health-store.ts` is split from `health-store-files.ts`
 * buys the same thing it bought there: this file runs under plain node. That is
 * what lets `tools/health-preview.cjs` render every one of these pages to a PNG
 * with no emulator, no AVD and no device - the previews come out of the REAL
 * paint code, so they cannot drift from what the glasses show the way a
 * separate mockup can. The first pass verified its layout by booting a full
 * Android emulator; this file is the reason that is no longer necessary.
 *
 * So the rule for this file: fonts and data arrive as arguments, nothing is
 * imported from `native/` or `@nativescript/core`, and nothing reaches for a
 * clock except through `data.nowMs`.
 */

import { GrayImage, type UiFont } from "../graphics/image";
import { lineStep } from "../ui/metrics";
import { GESTURE_SCROLL } from "../ui/gestures";
import {
  drawSleepLanes,
  drawMetricChart,
  drawTextRight,
  hypnogramCaptionShort,
  INK,
  rangeAverageText,
} from "./health-chart";
import {
  formatDuration,
  shortDate,
  stageSeconds,
  type DailySummary,
  type MetricSummary,
} from "./health-derive";
import {
  SAMPLE_METRIC_LABELS,
  SAMPLE_METRIC_SHORT_LABELS,
  SAMPLE_METRIC_UNITS,
  type RollupPoint,
  type SampleMetric,
} from "./health-types";
import { stageLabel, type SleepStageName } from "./sleep-stages";

const MARGIN = 10;
const GUTTER = 14;
/** Below this the two columns stack instead. */
const TWO_COLUMN_MIN_WIDTH = 380;

export type GlanceFonts = { small: UiFont; large: UiFont };

/**
 * One page of the glasses surface.
 *
 * ⚠ THE DRILL-DOWN IS A SCROLL CAROUSEL, AND THAT IS AN INTERPRETATION.
 * Chris, 2026-09-10: "Scrolling to a parameter on the glasses overview should
 * open that parameter's today/by-hour detail view... whichever line the user
 * has scrolled to." Read literally, the act of scrolling to a parameter is what
 * opens it - so scrolling walks a cursor through these pages and the page you
 * land on IS the detail view, rather than scrolling moving a highlight that a
 * second click then opens.
 *
 * Two things recommend the literal reading beyond its being literal. It costs
 * one gesture instead of two, which matches the direction of every other note
 * in that review (less on the glasses, not more). And it needs no back gesture:
 * the shell already takes double-click for "back out to home"
 * (`YieldAtRootLayer`), so a drill-down that needed its own back would have had
 * to invent one out of the ring's three remaining gestures. Scrolling up to
 * leave a page you scrolled down into needs nothing.
 *
 * Click is wired to advance as well, so a user who only ever clicks still gets
 * round. Recorded as a call, not a spec.
 */
export type GlancePage =
  | { kind: "overview" }
  | { kind: "metric"; metric: SampleMetric }
  | { kind: "sleep" };

/**
 * The cursor's order. Overview first, then the five measured parameters in the
 * order the overview lists them, then sleep - so scrolling down walks the
 * summary top to bottom and falls off the end into last night, which is where
 * the overview's right-hand column already pointed.
 */
export const GLANCE_PAGES: readonly GlancePage[] = [
  { kind: "overview" },
  { kind: "metric", metric: "heartRate" },
  { kind: "metric", metric: "spo2" },
  { kind: "metric", metric: "hrv" },
  { kind: "metric", metric: "steps" },
  { kind: "metric", metric: "calories" },
  { kind: "sleep" },
];

export type GlanceData = {
  summary: DailySummary | null;
  /** Today's by-hour series, per metric. Only the drill-down pages use it. */
  hourly: Partial<Record<SampleMetric, readonly RollupPoint[]>>;
  /** Last night as a run of stage blocks, for the sleep detail lanes. */
  stageBands: readonly { stage: SleepStageName | null; seconds: number }[];
  /** Wall clock, passed in rather than read, so a preview can pin the date. */
  nowMs: number;
  fixture: boolean;
};

export type GlanceSize = { width: number; height: number };

/** Paint whichever page the cursor is on. */
export function drawGlancePage(
  image: GrayImage,
  size: GlanceSize,
  fonts: GlanceFonts,
  page: GlancePage,
  data: GlanceData,
): void {
  switch (page.kind) {
    case "overview":
      drawOverview(image, size, fonts, data);
      return;
    case "metric":
      drawMetricDetail(image, size, fonts, page.metric, data);
      return;
    case "sleep":
      drawSleepDetail(image, size, fonts, data);
      return;
  }
}

// ===========================================================================
// Header and footer, shared by every page

function drawHeader(
  image: GrayImage,
  size: GlanceSize,
  fonts: GlanceFonts,
  title: string,
  right: string,
): number {
  const { small } = fonts;
  image.drawText(small, MARGIN, MARGIN, title, INK.title);
  drawTextRight(image, small, size.width - MARGIN, MARGIN, right, INK.label);
  const bottom = MARGIN + small.lineHeight + 3;
  image.drawLine(MARGIN, bottom, size.width - MARGIN, bottom, INK.axis);
  return bottom;
}

/**
 * The scroll hint, and the sample-data badge when the data is generated.
 *
 * The hint is not decoration: the drill-down has no on-screen affordance
 * otherwise - a page that opens on a scroll looks identical to a page that does
 * nothing until you try it.
 */
function drawFooter(
  image: GrayImage,
  size: GlanceSize,
  fonts: GlanceFonts,
  hint: string,
  fixture: boolean,
): void {
  const { small } = fonts;
  const y = size.height - small.lineHeight - 2;
  image.drawText(small, MARGIN, y, hint, INK.faint);
  if (fixture) drawTextRight(image, small, size.width - MARGIN, y, "Sample data", INK.faint);
}

// ===========================================================================
// 1. The overview - a summary, and nothing but

/**
 * ⚠ CUT DOWN 2026-09-10 on Chris's review. What left this page and why:
 *
 *   - The heart-rate trace chart. It was filling the left column's spare
 *     height and it is the single biggest thing on the page; "I think it just
 *     needs to be a summary".
 *   - The hypnogram strip under last night's stats, for the same reason.
 *   - The min/avg/max triple, replaced by range-and-average
 *     (`rangeAverageText`), which drops the "min / avg / max" legend line that
 *     existed only to decode the triple.
 *
 * What arrived: an HRV line, revising the first pass's spec.
 *
 * The net is that this page is now TEXT ONLY - no charts, no graphics. The
 * charts did not die, they moved: the trace is the heart-rate drill-down page
 * one scroll away, and the hypnogram became the sleep detail's four lanes.
 * That is the actual shape of the revision - the glance got smaller because the
 * drill-down gave its contents somewhere better to live.
 */
function drawOverview(
  image: GrayImage,
  size: GlanceSize,
  fonts: GlanceFonts,
  data: GlanceData,
): void {
  const { small, large } = fonts;
  const step = lineStep(small);
  const headerBottom = drawHeader(image, size, fonts, "HEALTH", shortDate(data.nowMs));
  const summary = data.summary;

  if (!summary) {
    image.drawText(small, MARGIN, headerBottom + step, "Waiting for ring data...", INK.dim);
    drawFooter(image, size, fonts, "", data.fixture);
    return;
  }

  const twoColumn = size.width >= TWO_COLUMN_MIN_WIDTH;
  const columnWidth = twoColumn
    ? Math.floor((size.width - MARGIN * 2 - GUTTER) / 2)
    : size.width - MARGIN * 2;
  const rightX = twoColumn ? MARGIN + columnWidth + GUTTER : MARGIN;
  const top = headerBottom + 6;

  const todayBottom = drawTodayColumn(image, summary, {
    x: MARGIN,
    y: top,
    width: columnWidth,
    fonts,
    step,
  });
  const nightTop = twoColumn ? top : todayBottom + 8;
  const nightBottom = drawNightColumn(image, summary, {
    x: rightX,
    y: nightTop,
    width: columnWidth,
    fonts,
    step,
  });

  if (twoColumn) {
    // The divider stops at the taller column rather than running to the footer.
    // Now that the page is text-only the columns fill about a third of the
    // height, and a rule continuing 300px past the last row reads as a drawing
    // artefact instead of as structure. It also matters more than it looks: on
    // the glasses an unlit pixel is TRANSPARENT, so every line drawn past the
    // content is one more thing between the wearer and the world.
    const divider = MARGIN + columnWidth + Math.floor(GUTTER / 2);
    image.drawLine(divider, top, divider, Math.max(todayBottom, nightBottom), INK.faint);
  }

  void large;
  drawFooter(image, size, fonts, `${GESTURE_SCROLL} detail`, data.fixture);
}

type ColumnLayout = {
  x: number;
  y: number;
  width: number;
  fonts: GlanceFonts;
  step: number;
};

function drawTodayColumn(image: GrayImage, summary: DailySummary, layout: ColumnLayout): number {
  const { x, width, fonts, step } = layout;
  const { small, large } = fonts;
  let y = layout.y;

  image.drawText(small, x, y, "TODAY", INK.label);
  y += step;

  // Steps get the large font: it is the number a glance is most often for.
  const stepsText = summary.steps > 0 ? summary.steps.toLocaleString() : "--";
  image.drawText(large, x, y, stepsText, INK.title);
  const stepsWidth = large.measureText(stepsText);
  image.drawText(
    small,
    x + stepsWidth + 6,
    y + large.lineHeight - small.lineHeight - 1,
    "steps",
    INK.label,
  );
  y += large.lineHeight + 4;

  const caloriesText = summary.calories > 0 ? `${summary.calories.toLocaleString()} kcal` : "-- kcal";
  image.drawText(small, x, y, caloriesText, INK.bar);
  y += step + 4;

  // Range and average, one line each, no legend line underneath.
  const rows: [string, MetricSummary, string][] = [
    ["HR", summary.heartRate, SAMPLE_METRIC_UNITS.heartRate],
    ["SpO2", summary.spo2, SAMPLE_METRIC_UNITS.spo2],
    ["HRV", summary.hrv, SAMPLE_METRIC_UNITS.hrv],
  ];
  for (const [label, metricSummary, unit] of rows) {
    image.drawText(small, x, y, label, INK.label);
    drawTextRight(image, small, x + width, y, rangeAverageText(metricSummary, unit), INK.line);
    y += step;
  }
  return y;
}

function drawNightColumn(image: GrayImage, summary: DailySummary, layout: ColumnLayout): number {
  const { x, width, fonts, step } = layout;
  const { small, large } = fonts;
  let y = layout.y;

  image.drawText(small, x, y, "LAST NIGHT", INK.label);
  y += step;

  const sleep = summary.sleep;
  if (!sleep) {
    image.drawText(small, x, y, "No sleep record", INK.dim);
    return y + step;
  }

  image.drawText(large, x, y, formatDuration(sleep.totalSec), INK.title);
  y += large.lineHeight + 4;

  image.drawText(small, x, y, "Efficiency", INK.label);
  drawTextRight(image, small, x + width, y, `${Math.round(sleep.efficiencyPercent)}%`, INK.line);
  y += step + 3;

  // The three stage shares Chris named, as percentages of time asleep. These
  // come from the record's own named totals, so they are unaffected by the
  // unconfirmed stage-id mapping the sleep detail's lanes depend on.
  const rows: [string, number][] = [
    ["REM", sleep.remPercent],
    ["Deep", sleep.deepPercent],
    ["Light", sleep.lightPercent],
  ];
  for (const [label, percent] of rows) {
    image.drawText(small, x, y, label, INK.label);
    drawTextRight(image, small, x + width, y, `${Math.round(percent)}%`, INK.line);
    y += step;
  }
  return y;
}

// ===========================================================================
// 4. The drill-down: one parameter, today, by hour

/**
 * What the phone's Day view shows for this metric, on the glasses.
 *
 * The headline repeats the overview's range-and-average line at full size, so
 * the page answers the glance's question before the chart is read at all; the
 * chart then says WHEN. That ordering is the point of the drill-down - "74 avg"
 * and "and it was 130 at five o'clock" are different facts.
 */
function drawMetricDetail(
  image: GrayImage,
  size: GlanceSize,
  fonts: GlanceFonts,
  metric: SampleMetric,
  data: GlanceData,
): void {
  const { small, large } = fonts;
  const step = lineStep(small);
  const headerBottom = drawHeader(
    image,
    size,
    fonts,
    SAMPLE_METRIC_LABELS[metric].toUpperCase(),
    "today, by hour",
  );
  let y = headerBottom + 6;

  const summary = summaryFor(metric, data.summary);
  const unit = SAMPLE_METRIC_UNITS[metric];

  if (isCumulativeMetric(metric)) {
    // Steps and calories are totals, not measurements with a spread, so the
    // headline is the day's total rather than a range.
    const total = metric === "steps" ? data.summary?.steps ?? 0 : data.summary?.calories ?? 0;
    const text = total > 0 ? total.toLocaleString() : "--";
    image.drawText(large, MARGIN, y, text, INK.title);
    const width = large.measureText(text);
    if (unit) {
      image.drawText(
        small,
        MARGIN + width + 6,
        y + large.lineHeight - small.lineHeight - 1,
        unit,
        INK.label,
      );
    }
    y += large.lineHeight + 6;
  } else {
    image.drawText(small, MARGIN, y, rangeAverageText(summary, unit), INK.line);
    y += step + 4;
  }

  const points = data.hourly[metric] ?? [];
  const footerHeight = small.lineHeight + 8;
  const chartHeight = size.height - y - MARGIN - footerHeight;
  if (chartHeight >= 40) {
    drawMetricChart(
      image,
      { x: MARGIN, y, width: size.width - MARGIN * 2, height: chartHeight },
      {
        metric,
        points,
        font: small,
        // Just format the hour - `drawMetricChart` already thins labels to
        // whatever the column width fits. Thinning here as well multiplies the
        // two and leaves a single label at midnight.
        xLabel: (point) => `${new Date(point.startMs).getHours()}`,
      },
    );
  }

  drawFooter(image, size, fonts, `${GESTURE_SCROLL} ${pageHint(metric)}`, data.fixture);
}

function summaryFor(metric: SampleMetric, summary: DailySummary | null): MetricSummary {
  const empty: MetricSummary = { min: 0, max: 0, avg: 0, hasData: false };
  if (!summary) return empty;
  if (metric === "heartRate") return summary.heartRate;
  if (metric === "spo2") return summary.spo2;
  if (metric === "hrv") return summary.hrv;
  return empty;
}

function isCumulativeMetric(metric: SampleMetric): boolean {
  return metric === "steps" || metric === "calories";
}

/** "SpO2 · HRV" - what scrolling either way from here reaches. */
function pageHint(metric: SampleMetric): string {
  const index = GLANCE_PAGES.findIndex(
    (page) => page.kind === "metric" && page.metric === metric,
  );
  const previous = GLANCE_PAGES[index - 1];
  const next = GLANCE_PAGES[index + 1];
  return [pageName(previous), pageName(next)].filter(Boolean).join(" · ");
}

function pageName(page: GlancePage | undefined): string {
  if (!page) return "";
  if (page.kind === "overview") return "Summary";
  if (page.kind === "sleep") return "Sleep";
  return SAMPLE_METRIC_SHORT_LABELS[page.metric];
}

// ===========================================================================
// 4b. The drill-down's special case: one night, four lanes

/**
 * Sleep's own detail page: the four categories arranged vertically, top to
 * bottom as Awake, Light, REM, Deep.
 *
 * The ordering is Chris's and is deliberately not the week chart's - see
 * `drawSleepLanes`, which owns the drawing and carries the reasoning and the
 * flagged proportions call.
 *
 * The unconfirmed-mapping caption rides along because this page IS the
 * hypnogram: lanes are the only thing on either surface that depends on the raw
 * stage ids, so it is the only place that has to hedge. The overview's
 * percentages come from named totals and say so by not carrying this caption.
 */
function drawSleepDetail(
  image: GrayImage,
  size: GlanceSize,
  fonts: GlanceFonts,
  data: GlanceData,
): void {
  const { small, large } = fonts;
  const step = lineStep(small);
  const sleep = data.summary?.sleep ?? null;
  const headerBottom = drawHeader(image, size, fonts, "SLEEP", "last night");
  let y = headerBottom + 6;

  if (!sleep) {
    image.drawText(small, MARGIN, y, "No sleep record", INK.dim);
    drawFooter(image, size, fonts, `${GESTURE_SCROLL} Calories · Summary`, data.fixture);
    return;
  }

  // Total and efficiency on one line, so the lanes get the height.
  const totalText = formatDuration(sleep.totalSec);
  image.drawText(large, MARGIN, y, totalText, INK.title);
  drawTextRight(
    image,
    small,
    size.width - MARGIN,
    y + large.lineHeight - small.lineHeight - 1,
    `${Math.round(sleep.efficiencyPercent)}% efficiency`,
    INK.label,
  );
  y += large.lineHeight + 6;

  const footerHeight = small.lineHeight + 8;
  const captionHeight = step;
  const laneHeight = size.height - y - MARGIN - footerHeight - captionHeight;
  if (laneHeight >= 40) {
    drawSleepLanes(
      image,
      { x: MARGIN, y, width: size.width - MARGIN * 2, height: laneHeight },
      {
        bands: data.stageBands,
        font: small,
        laneText: (stage) => ({
          label: stageLabel(stage),
          value: formatDuration(stageSeconds(stage, sleep)),
        }),
      },
    );
    y += laneHeight;
  }

  image.drawText(small, MARGIN, y, hypnogramCaptionShort(), INK.faint);
  drawFooter(image, size, fonts, `${GESTURE_SCROLL} Calories · Summary`, data.fixture);
}
