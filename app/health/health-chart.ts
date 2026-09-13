/**
 * The chart renderer, shared by both surfaces.
 *
 * Both the glasses glance and the phone graphs draw into a `GrayImage`, and
 * the phone converts its one through `grayImageToPreviewSource()` - the same
 * already-shipping path the glasses mirror uses to put a rendered frame on the
 * phone screen. That is a deliberate reuse rather than a shortcut: it means
 * one drawing implementation covers both surfaces, no new native code exists
 * for the phone side, and the two screens cannot drift apart visually.
 *
 * ⚠ DESIGN CHOICE, not a spec (Chris said only "the Even app wasn't bad for
 * this, I liked their summaries, but we can't copy it, we have to make our
 * own"): the phone charts are MONOCHROME, because that is what
 * `PreviewBitmapUtil.fromGray` produces and adding colour would mean new
 * Kotlin. It lands somewhere deliberate rather than accidental - the phone
 * already shows the glasses' grey mirror, so the health screens read as part
 * of the same instrument - but colour is a real option later and would be a
 * contained change: a second bitmap builder plus a palette here.
 *
 * Nothing in this file imports NativeScript, and that is load-bearing rather
 * than incidental: `tools/health-preview.cjs` renders these functions under
 * plain node and writes PNGs, so a layout can be looked at without an Android
 * emulator in the loop. Keep it that way - the fonts arrive as `UiFont`
 * arguments precisely so no drawing code ever has to reach for the platform.
 */

import { GrayImage } from "../graphics/image";
import { type UiFont } from "../graphics/image";
import {
  type RollupPoint,
  type SampleMetric,
  type SleepNight,
  isCumulative,
} from "./health-types";
import { bandIsMeaningful, formatValue, primaryValue } from "./health-derive";
import { STAGE_MAPPING_CONFIRMED, type SleepStageName } from "./sleep-stages";

/**
 * The grey ramp. Everything drawn here uses one of these.
 *
 * ⚠ RAISED FOR CONTRAST, 2026-09-10 (Chris, reviewing the first pass): "the
 * chart axis labels/gridlines are too low-contrast - dark grey on black, hard
 * to read". The old ramp put gridlines at 42 and axis labels at 148 on a black
 * plate, which on the phone's dark chart surface left the gridlines essentially
 * invisible and the numbers a squint. Gridlines, the axis line and label text
 * all moved up.
 *
 * `faint` is new and is where the things that were DELIBERATELY quiet went -
 * the sample-data badge, the column divider, an unmapped hypnogram block. They
 * used to share `grid`'s value, so raising `grid` for legibility would have
 * dragged them up too; splitting the token is what lets the chart get brighter
 * without the furniture shouting.
 */
export const INK = {
  background: 0,
  /** Deliberately quiet furniture - badges, dividers, unmapped blocks. */
  faint: 46,
  grid: 100,
  axis: 145,
  band: 82,
  bar: 168,
  line: 250,
  label: 205,
  title: 255,
  dim: 125,
} as const;

export type ChartRect = { x: number; y: number; width: number; height: number };

export type ChartOptions = {
  /** Only used to pick the default mode and to read `avg` vs `sum`. */
  metric: SampleMetric;
  points: readonly RollupPoint[];
  font: UiFont;
  /** Formats a point's x-axis label; return "" to leave a tick unlabelled. */
  xLabel: (point: RollupPoint, index: number) => string;
  /**
   * `band` draws a min/max band with the average through it; `bars` draws a
   * column per bucket from zero. Defaults to bars for the cumulative metrics.
   */
  mode?: "band" | "bars";
};

/**
 * A min/max band with the average tracked through it, or bars for the
 * cumulative metrics.
 *
 * Gaps are drawn as gaps. A ring is taken off to charge, so missing hours are
 * the normal case, not an edge case, and a line that joins across them claims
 * a continuity the data does not have.
 */
export function drawMetricChart(image: GrayImage, rect: ChartRect, options: ChartOptions): void {
  const { metric, points, font } = options;
  const labelWidth = Math.max(34, font.measureText("8888") + 6);
  const labelHeight = font.lineHeight + 2;
  const plot: ChartRect = {
    x: rect.x + labelWidth,
    y: rect.y,
    width: Math.max(8, rect.width - labelWidth),
    height: Math.max(8, rect.height - labelHeight),
  };

  const withData = points.filter((point) => point.count > 0);
  if (withData.length === 0) {
    drawNoData(image, rect, font);
    return;
  }

  const bars = options.mode ? options.mode === "bars" : isCumulative(metric);
  const scale = valueScale(withData, bars);
  const showBand = !bars && bandIsMeaningful(points);

  drawGrid(image, plot, scale, font, rect.x);

  const slotWidth = plot.width / points.length;
  const yFor = (value: number): number =>
    plot.y + plot.height - ((value - scale.low) / scale.span) * plot.height;

  if (bars) {
    const barWidth = Math.max(1, Math.floor(slotWidth * 0.62));
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]!;
      if (point.count === 0) continue;
      const top = yFor(point.sum);
      const left = Math.round(plot.x + index * slotWidth + (slotWidth - barWidth) / 2);
      const height = Math.max(1, Math.round(plot.y + plot.height - top));
      image.fillRect(left, Math.round(top), barWidth, height, INK.bar);
    }
  } else {
    if (showBand) {
      for (let index = 0; index < points.length; index += 1) {
        const point = points[index]!;
        if (point.count === 0) continue;
        const left = Math.round(plot.x + index * slotWidth);
        const width = Math.max(1, Math.round(slotWidth));
        const top = Math.round(yFor(point.max));
        const bottom = Math.round(yFor(point.min));
        image.fillRect(left, top, width, Math.max(1, bottom - top), INK.band);
      }
    }
    // The average line, drawn only between adjacent points that both have
    // data, so a gap stays a gap.
    let previous: { x: number; y: number } | null = null;
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]!;
      if (point.count === 0) {
        previous = null;
        continue;
      }
      const cx = plot.x + index * slotWidth + slotWidth / 2;
      const cy = yFor(primaryValue(point, metric));
      if (previous) image.drawLine(previous.x, previous.y, cx, cy, INK.line);
      else image.fillRect(Math.round(cx), Math.round(cy), 1, 1, INK.line);
      previous = { x: cx, y: cy };
    }
  }

  drawXLabels(image, plot, points, font, rect, options.xLabel);
}

function drawNoData(image: GrayImage, rect: ChartRect, font: UiFont): void {
  const message = "No data for this range";
  image.drawText(
    font,
    rect.x + Math.round((rect.width - font.measureText(message)) / 2),
    rect.y + Math.round(rect.height / 2) - font.lineHeight,
    message,
    INK.dim,
  );
}

/** X labels along the bottom of a plot, thinned so they never collide. */
function drawXLabels(
  image: GrayImage,
  plot: ChartRect,
  points: readonly { startMs: number }[],
  font: UiFont,
  clip: ChartRect,
  xLabel: (point: never, index: number) => string,
): void {
  const slotWidth = plot.width / Math.max(1, points.length);
  const step = Math.max(1, Math.ceil(46 / Math.max(1, slotWidth)));
  const labelY = plot.y + plot.height + 2;
  for (let index = 0; index < points.length; index += step) {
    const text = xLabel(points[index]! as never, index);
    if (!text) continue;
    const cx = plot.x + index * slotWidth + slotWidth / 2;
    const x = Math.round(cx - font.measureText(text) / 2);
    if (x < clip.x || x + font.measureText(text) > clip.x + clip.width) continue;
    image.drawText(font, x, labelY, text, INK.label);
  }
}

type Scale = { low: number; high: number; span: number };

function valueScale(points: readonly RollupPoint[], bars: boolean): Scale {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const top = bars ? point.sum : point.max;
    const bottom = bars ? 0 : point.min;
    if (bottom < low) low = bottom;
    if (top > high) high = top;
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return { low: 0, high: 1, span: 1 };
  if (bars) low = 0;
  if (high - low < 1) {
    // A flat series still needs somewhere to sit; centre it rather than
    // letting it collapse onto the axis.
    low -= 1;
    high += 1;
  }
  // Bars are measured from zero, so only the top gets breathing room - padding
  // the bottom too would put a negative tick under a count that cannot go
  // negative, and float the bars off their own baseline.
  const pad = (high - low) * 0.08;
  const scale = { low: bars ? low : low - pad, high: high + pad, span: 0 };
  scale.span = scale.high - scale.low || 1;
  return scale;
}

function drawGrid(
  image: GrayImage,
  plot: ChartRect,
  scale: Scale,
  font: UiFont,
  labelX: number,
): void {
  const lines = 3;
  for (let index = 0; index < lines; index += 1) {
    const fraction = index / (lines - 1);
    const value = scale.high - fraction * scale.span;
    const y = Math.round(plot.y + fraction * plot.height);
    image.drawLine(plot.x, y, plot.x + plot.width, y, INK.grid);
    const text = `${Math.round(value)}`;
    const textY = Math.min(
      plot.y + plot.height - font.lineHeight,
      Math.max(plot.y, y - Math.round(font.lineHeight / 2)),
    );
    image.drawText(font, labelX, textY, text, INK.label);
  }
  image.drawLine(plot.x, plot.y, plot.x, plot.y + plot.height, INK.axis);
}

// ===========================================================================
// Sleep

/**
 * Stage inks.
 *
 * ⚠ RAISED AND REORDERED, 2026-09-10, alongside the diverging sleep chart.
 * Within the upward stack the ramp descends with height - deep (bottom) is the
 * brightest, light (top) the dimmest - so the three read as one column with a
 * clear internal order rather than three similar greys.
 *
 * `wake` is deliberately NOT the dimmest any more, which looks wrong in a list
 * and is right on the chart: awake time is drawn BELOW the zero line, so it is
 * separated from the stack spatially rather than by brightness. That frees it
 * to be legible (Chris's contrast note applies to it as much as to the axes)
 * without it reading as part of the sleep stack.
 */
const STAGE_INK: Readonly<Record<SleepStageName, number>> = {
  wake: 150,
  rem: 180,
  light: 112,
  deep: 250,
};

export function stageInk(stage: SleepStageName): number {
  return STAGE_INK[stage];
}

/**
 * The night as a run of stage blocks.
 *
 * This is the ONE thing on either surface that depends on the raw stage-id
 * mapping, so while `STAGE_MAPPING_CONFIRMED` is false the caller is expected
 * to caption it as unconfirmed - `hypnogramCaption()` supplies the wording.
 */
export function drawHypnogram(
  image: GrayImage,
  rect: ChartRect,
  bands: readonly { stage: SleepStageName | null; seconds: number }[],
): void {
  let total = 0;
  for (const band of bands) total += band.seconds;
  if (total <= 0) return;
  let x = rect.x;
  for (const band of bands) {
    const width = (band.seconds / total) * rect.width;
    const drawn = Math.max(1, Math.round(width));
    // An unmapped stage id is drawn as a hatch-dim block rather than being
    // dropped: the time happened, we just cannot name it.
    const ink = band.stage ? STAGE_INK[band.stage] : INK.faint;
    image.fillRect(Math.round(x), rect.y, drawn, rect.height, ink);
    x += width;
  }
  image.drawRect(rect.x, rect.y, rect.width, rect.height, INK.axis);
}

export function hypnogramCaption(): string {
  return STAGE_MAPPING_CONFIRMED
    ? "Sleep stages through the night"
    : "Stage pattern - labels not yet confirmed on live data";
}

/** The same caption for the glasses, where the line is 300-odd pixels wide. */
export function hypnogramCaptionShort(): string {
  return STAGE_MAPPING_CONFIRMED ? "Stages through the night" : "Stages - labels unconfirmed";
}

// ===========================================================================
// The diverging nightly sleep chart (week / month / 3 months)

/**
 * A night as a DIVERGING stacked bar - Chris's design, 2026-09-10.
 *
 * Sleep stacks upward from zero in the order deep (bottom), REM (middle),
 * light (top). Awake time stacks DOWNWARD, below the zero line, as its own
 * segment.
 *
 * The divergence is the whole idea and it is a claim about the data, not a
 * styling choice: awake time is not a kind of sleep, so stacking it with the
 * others would make a restless night's column look like a long one. Putting it
 * below the line means the upward height is always "how much you slept" and
 * can be compared across nights at a glance, while the downward tail says what
 * it cost. A legend names the four, because a monochrome stack is not
 * self-describing.
 *
 * ⚠ The stage ORDER is specified (deep/REM/light bottom-to-top, awake below);
 * the axis ticks, the 1px separators and the legend placement are mine.
 */
/**
 * The upward stack, BOTTOM TO TOP. Deep is the foundation of the column.
 *
 * See `SLEEP_LANE_ORDER` for why this and the lane order only look like they
 * disagree.
 */
export const SLEEP_STACK_ORDER: readonly SleepStageName[] = ["deep", "rem", "light"];

/**
 * The one-night detail's lanes, TOP TO BOTTOM.
 *
 * ⚠ THESE TWO ORDERS LOOK CONTRADICTORY AND ARE NOT. Chris gave both in the
 * same review, in opposite directions: the week/month chart stacks "Deep
 * (bottom), REM (middle), light (top)" upward with awake below zero, and the
 * one-day view lists "Awake, light, REM, Deep" downward. Stated that way they
 * read as a conflict, which is why the brief flagged the difference as
 * deliberate rather than a typo.
 *
 * Resolve both to the same direction and the conflict disappears. Top to
 * bottom, the stack is light / REM / deep; top to bottom, the lanes are awake /
 * light / REM / deep. The three sleep stages are in the SAME vertical order in
 * both views - deep at the bottom, light nearest the top - so a reader who
 * learns the arrangement on one screen reads the other correctly without
 * relearning it.
 *
 * The one genuine difference is where awake goes: its own lane above the
 * others here, its own bar below the zero line there. That follows from what
 * each view is: a timeline has to show awake in sequence with everything else,
 * and a stacked total must not add it to the sleep it interrupted.
 *
 * A test pins the agreement, so "fixing" either order breaks it loudly.
 */
export const SLEEP_LANE_ORDER: readonly SleepStageName[] = ["wake", "light", "rem", "deep"];

/** Descending "nice" ticks for the awake axis, in hours: 4h..5m. */
const DOWN_TICK_HOURS = [4, 2, 1, 0.5, 0.25, 1 / 6, 1 / 12];

/** "2" for whole hours, "30m" below one - the awake side is usually minutes. */
function formatHourTick(hours: number): string {
  return hours >= 1 ? `${hours}` : `${Math.round(hours * 60)}m`;
}

export function drawSleepStackChart(
  image: GrayImage,
  rect: ChartRect,
  options: {
    nights: readonly SleepNight[];
    font: UiFont;
    xLabel: (night: SleepNight, index: number) => string;
  },
): void {
  const { nights, font } = options;
  const labelWidth = Math.max(34, font.measureText("-88m") + 6);
  const legendHeight = font.lineHeight + 4;
  const labelHeight = font.lineHeight + 2;
  const plot: ChartRect = {
    x: rect.x + labelWidth,
    y: rect.y + legendHeight,
    width: Math.max(8, rect.width - labelWidth),
    height: Math.max(8, rect.height - labelHeight - legendHeight),
  };

  drawStageLegend(image, rect.x, rect.y, rect.width, font);

  const withData = nights.filter((night) => night.hasData);
  if (withData.length === 0) {
    drawNoData(image, rect, font);
    return;
  }

  const hours = (seconds: number): number => seconds / 3600;
  let maxUp = 0;
  let maxDown = 0;
  for (const night of withData) {
    const up = hours(night.deepSec + night.remSec + night.lightSec);
    const down = hours(night.wakeSec);
    if (up > maxUp) maxUp = up;
    if (down > maxDown) maxDown = down;
  }
  // Headroom above, and a floor under the awake band so a night with almost no
  // wake time still leaves the zero line off the bottom edge.
  maxUp = Math.max(1, maxUp * 1.08);
  maxDown = Math.max(0.5, maxDown * 1.15);

  const span = maxUp + maxDown;
  const zeroY = Math.round(plot.y + (maxUp / span) * plot.height);
  const pxPerHour = plot.height / span;

  // Gridlines: whole hours above zero, and one below for the awake side.
  const upStep = maxUp > 9 ? 4 : maxUp > 4 ? 2 : 1;
  for (let hour = upStep; hour <= maxUp; hour += upStep) {
    const y = Math.round(zeroY - hour * pxPerHour);
    if (y < plot.y) break;
    image.drawLine(plot.x, y, plot.x + plot.width, y, INK.grid);
    image.drawText(font, rect.x, y - Math.round(font.lineHeight / 2), `${hour}`, INK.label);
  }
  // The awake side needs its own tick ladder, not the hour steps used above.
  // A typical night is six hours of sleep against ten or twenty minutes awake,
  // so a whole-hour tick below zero falls off the bottom of the chart and the
  // downward axis ends up unlabelled - which is what the first cut of this did.
  const downTick = DOWN_TICK_HOURS.find((hours) => hours <= maxDown * 0.95);
  if (downTick !== undefined) {
    const downY = Math.round(zeroY + downTick * pxPerHour);
    if (downY <= plot.y + plot.height) {
      image.drawLine(plot.x, downY, plot.x + plot.width, downY, INK.grid);
      image.drawText(
        font,
        rect.x,
        downY - Math.round(font.lineHeight / 2),
        `-${formatHourTick(downTick)}`,
        INK.label,
      );
    }
  }

  const slotWidth = plot.width / nights.length;
  const barWidth = Math.max(1, Math.floor(slotWidth * 0.68));

  for (let index = 0; index < nights.length; index += 1) {
    const night = nights[index]!;
    if (!night.hasData) continue;
    const left = Math.round(plot.x + index * slotWidth + (slotWidth - barWidth) / 2);

    // Upward: deep at the bottom, then REM, then light. Drawn from the zero
    // line outward so rounding never opens a gap at the baseline.
    let cursor = zeroY;
    const secondsByStage: Record<SleepStageName, number> = {
      deep: night.deepSec,
      rem: night.remSec,
      light: night.lightSec,
      wake: night.wakeSec,
    };
    const upward: [number, number][] = SLEEP_STACK_ORDER.map((stage) => [
      secondsByStage[stage],
      STAGE_INK[stage],
    ]);
    for (const [seconds, ink] of upward) {
      if (seconds <= 0) continue;
      const height = Math.max(1, Math.round(hours(seconds) * pxPerHour));
      const top = Math.max(plot.y, cursor - height);
      image.fillRect(left, top, barWidth, Math.max(1, cursor - top), ink);
      cursor = top;
      // A 1px unlit separator so two adjacent greys stay two segments. Only
      // worth it when the bar is tall enough to still read as a block.
      if (cursor > plot.y + 1 && height > 3) {
        image.fillRect(left, cursor, barWidth, 1, INK.background);
      }
    }

    // Downward: awake, below the line.
    if (night.wakeSec > 0) {
      const height = Math.max(1, Math.round(hours(night.wakeSec) * pxPerHour));
      const bottom = Math.min(plot.y + plot.height, zeroY + 1 + height);
      image.fillRect(left, zeroY + 1, barWidth, Math.max(1, bottom - zeroY - 1), STAGE_INK.wake);
    }
  }

  // The zero line last, so it sits on top of every bar that touches it - it is
  // the reference the whole chart is read against.
  image.drawLine(plot.x, zeroY, plot.x + plot.width, zeroY, INK.axis);
  image.drawText(font, rect.x, zeroY - Math.round(font.lineHeight / 2), "0", INK.label);
  image.drawLine(plot.x, plot.y, plot.x, plot.y + plot.height, INK.axis);

  drawXLabels(
    image,
    { ...plot, y: plot.y, height: plot.height },
    nights,
    font,
    { ...rect, y: plot.y, height: plot.height },
    ((night: SleepNight, index: number) => options.xLabel(night, index)) as never,
  );
}

/**
 * The four stages as swatch + name, on one line.
 *
 * Awake is listed last and marked, because its bar goes the other way and a
 * legend that reads deep/REM/light/awake in a row would imply they stack
 * together.
 */
export function drawStageLegend(
  image: GrayImage,
  x: number,
  y: number,
  width: number,
  font: UiFont,
): void {
  const entries: [string, number][] = [
    ["Deep", STAGE_INK.deep],
    ["REM", STAGE_INK.rem],
    ["Light", STAGE_INK.light],
    ["Awake v", STAGE_INK.wake],
  ];
  const swatch = Math.max(6, font.lineHeight - 4);
  let cursor = x;
  for (const [label, ink] of entries) {
    const textWidth = font.measureText(label);
    const entryWidth = swatch + 4 + textWidth + 12;
    if (cursor + entryWidth > x + width) break;
    image.fillRect(cursor, y + 2, swatch, swatch, ink);
    image.drawRect(cursor, y + 2, swatch, swatch, INK.axis);
    image.drawText(font, cursor + swatch + 4, y, label, INK.label);
    cursor += entryWidth;
  }
}

// ===========================================================================
// The one-night sleep detail (the glasses drill-down)

/**
 * One night as four horizontal LANES, stacked top to bottom in the order
 * Awake, Light, REM, Deep - Chris's ordering, 2026-09-10. It is stated in the
 * opposite direction from the week chart's and therefore reads as a conflict
 * with it; it is not one, and `SLEEP_LANE_ORDER` explains why. Both views put
 * deep at the bottom.
 *
 * ⚠ PROPORTIONS ARE A DESIGN CALL. The stage order and the top-to-bottom
 * orientation are specified; "exactly what arranged vertically should look
 * like pixel-for-pixel wasn't specified further than that ordering". So: four
 * equal-height lanes across the full width of the night, each lane's blocks
 * filled where the sleeper was in that stage, with the lane's name and its
 * total on the left. Equal heights rather than height-proportional-to-duration,
 * because the lane's JOB is to show when that stage happened, and a 4%-of-night
 * deep lane squeezed to a few pixels would show nothing.
 */
export function drawSleepLanes(
  image: GrayImage,
  rect: ChartRect,
  options: {
    bands: readonly { stage: SleepStageName | null; seconds: number }[];
    font: UiFont;
    /** Left-column label + total for each lane, in lane order. */
    laneText: (stage: SleepStageName) => { label: string; value: string };
  },
): void {
  const { bands, font } = options;
  const LANE_ORDER = SLEEP_LANE_ORDER;

  let total = 0;
  for (const band of bands) total += band.seconds;
  if (total <= 0) {
    drawNoData(image, rect, font);
    return;
  }

  // The left column has to fit "Awake" plus its duration; measure rather than
  // guess, so a larger UI font does not overrun the lanes.
  let gutter = 0;
  for (const stage of LANE_ORDER) {
    const text = options.laneText(stage);
    gutter = Math.max(gutter, font.measureText(text.label), font.measureText(text.value));
  }
  gutter += 10;

  const laneX = rect.x + gutter;
  const laneWidth = Math.max(8, rect.width - gutter);
  const axisHeight = font.lineHeight + 2;
  const laneGap = 4;
  const laneHeight = Math.max(
    6,
    Math.floor((rect.height - axisHeight - laneGap * (LANE_ORDER.length - 1)) / LANE_ORDER.length),
  );

  for (let index = 0; index < LANE_ORDER.length; index += 1) {
    const stage = LANE_ORDER[index]!;
    const top = rect.y + index * (laneHeight + laneGap);
    const text = options.laneText(stage);

    // The lane's own track, so an empty stretch still reads as a lane rather
    // than as nothing.
    image.drawRect(laneX, top, laneWidth, laneHeight, INK.faint);

    let cursor = laneX;
    for (const band of bands) {
      const width = (band.seconds / total) * laneWidth;
      if (band.stage === stage) {
        image.fillRect(Math.round(cursor), top, Math.max(1, Math.round(width)), laneHeight, STAGE_INK[stage]);
      }
      cursor += width;
    }

    // Name above its own duration, both in the gutter, vertically centred on
    // the lane when there is room for two lines.
    const twoLines = laneHeight >= font.lineHeight * 2;
    const textTop = twoLines
      ? top + Math.round((laneHeight - font.lineHeight * 2) / 2)
      : top + Math.round((laneHeight - font.lineHeight) / 2);
    image.drawText(font, rect.x, textTop, text.label, INK.label);
    if (twoLines) image.drawText(font, rect.x, textTop + font.lineHeight, text.value, INK.line);
  }

  // A time axis under the lanes: the night runs left to right, so mark its
  // ends. Without this the lanes are a proportion with no anchor.
  const axisY = rect.y + LANE_ORDER.length * (laneHeight + laneGap);
  image.drawLine(laneX, axisY, laneX + laneWidth, axisY, INK.axis);
}

// ===========================================================================
// Small shared pieces

/**
 * A "min / avg / max" readout, the shape both surfaces use for a metric.
 *
 * `whole` rounds all three. The glance passes it: an average heart rate
 * printed as 72.7 reads as precision the measurement does not have, and on a
 * screen you glance at rather than study, the tenth is noise. The phone's stat
 * panel keeps the decimal, where comparing two averages is the point.
 */
export function tripleText(
  summary: { min: number; max: number; avg: number; hasData: boolean },
  metric: SampleMetric,
  options?: { whole?: boolean },
): string {
  if (!summary.hasData) return "--";
  const show = (value: number): string =>
    options?.whole ? `${Math.round(value)}` : formatValue(value, metric);
  return `${show(summary.min)} / ${show(summary.avg)} / ${show(summary.max)}`;
}

/**
 * "60-98 bpm, avg 73" - the glance's metric line.
 *
 * ⚠ REPLACES the min/avg/max triple on the glasses overview, Chris 2026-09-10:
 * three bare numbers under a "min / avg / max" legend made the reader do the
 * decoding. A range and an average is the same information said in the shape a
 * person would say it in, and it needs no legend line underneath.
 *
 * The separator is an ASCII hyphen, not an en dash: the glasses render through
 * Terminus, and a codepoint the face does not carry comes back as the default
 * char - a "?" in the middle of the number - rather than failing loudly.
 */
export function rangeAverageText(
  summary: { min: number; max: number; avg: number; hasData: boolean },
  unit: string,
): string {
  if (!summary.hasData) return "--";
  const whole = (value: number): string => `${Math.round(value)}`;
  const range = `${whole(summary.min)}-${whole(summary.max)}`;
  return unit ? `${range} ${unit}, avg ${whole(summary.avg)}` : `${range}, avg ${whole(summary.avg)}`;
}

/** A right-aligned draw, for readouts that should line up on their last digit. */
export function drawTextRight(
  image: GrayImage,
  font: UiFont,
  right: number,
  y: number,
  text: string,
  value: number,
): void {
  image.drawText(font, Math.round(right - font.measureText(text)), y, text, value);
}
