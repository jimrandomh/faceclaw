/**
 * Every derived number the two health surfaces show, in one place, with no
 * NativeScript imports so it runs under plain node in `tests/`.
 *
 * The rule this file follows throughout: show what the ring actually said, or
 * say we do not know. Nothing here invents a value to fill a gap, and the one
 * composite score a health app is expected to have - a 0-100 "sleep quality" -
 * is deliberately absent. See `sleepSummary` for why.
 */

import {
  DAY_MS,
  HOUR_MS,
  type HealthSample,
  type Rollup,
  type RollupPoint,
  type SampleMetric,
  type SleepNight,
  type SleepSession,
  isCumulative,
  rollupOf,
  startOfLocalDay,
  startOfLocalHour,
} from "./health-types";
import { STAGE_DISPLAY_ORDER, type SleepStageName, stageNameForId } from "./sleep-stages";

export type Granularity = "hour" | "day";

/** How far back a chart looks. Hour granularity only makes sense within a day. */
export type RangeKey = "day" | "week" | "month" | "quarter";

export const RANGE_DAYS: Readonly<Record<RangeKey, number>> = {
  day: 1,
  week: 7,
  month: 30,
  quarter: 90,
};

export const RANGE_LABELS: Readonly<Record<RangeKey, string>> = {
  day: "Day",
  week: "Week",
  month: "Month",
  quarter: "3 months",
};

/**
 * Bucket samples into a series of rollups on a fixed grid.
 *
 * The grid is built first and then filled, so a window with no data comes back
 * as a gap (`count === 0`) at its real position rather than being silently
 * dropped - a chart that closes over its gaps lies about continuity, which for
 * a ring that is taken off to charge is the common case, not an edge case.
 */
export function rollupSeries(
  samples: readonly HealthSample[],
  options: {
    metric: SampleMetric;
    granularity: Granularity;
    /** Inclusive local start of the plotted window. */
    startMs: number;
    /** Exclusive local end. */
    endMs: number;
  },
): RollupPoint[] {
  const { metric, granularity, startMs, endMs } = options;
  const spanMs = granularity === "hour" ? HOUR_MS : DAY_MS;
  const align = granularity === "hour" ? startOfLocalHour : startOfLocalDay;

  const buckets = new Map<number, HealthSample[]>();
  for (const sample of samples) {
    if (sample.metric !== metric) continue;
    if (sample.startMs < startMs || sample.startMs >= endMs) continue;
    const key = align(sample.startMs);
    const list = buckets.get(key);
    if (list) list.push(sample);
    else buckets.set(key, [sample]);
  }

  const points: RollupPoint[] = [];
  // Walk by calendar step rather than adding spanMs, so a DST change does not
  // shift every later bucket by an hour.
  let cursor = align(startMs);
  let guard = 0;
  while (cursor < endMs && guard < 4000) {
    guard += 1;
    const inBucket = buckets.get(cursor) ?? [];
    const rolled = rollupOf(inBucket);
    points.push({
      startMs: cursor,
      spanMs,
      ...(rolled ?? { min: 0, max: 0, avg: 0, sum: 0, count: 0 }),
    });
    cursor = nextBucketStart(cursor, granularity);
  }
  return points;
}

function nextBucketStart(startMs: number, granularity: Granularity): number {
  const date = new Date(startMs);
  if (granularity === "hour") date.setHours(date.getHours() + 1, 0, 0, 0);
  else date.setDate(date.getDate() + 1);
  return date.getTime();
}

/** The value a chart plots as "the" line for a metric. */
export function primaryValue(point: Rollup, metric: SampleMetric): number {
  return isCumulative(metric) ? point.sum : point.avg;
}

// ===========================================================================
// The glasses status page's numbers

export type MetricSummary = {
  min: number;
  max: number;
  avg: number;
  /** False when nothing was recorded - the UI shows a dash, not a zero. */
  hasData: boolean;
};

export type DailySummary = {
  dayStartMs: number;
  steps: number;
  calories: number;
  heartRate: MetricSummary;
  spo2: MetricSummary;
  /**
   * ⚠ ADDED 2026-09-10. The first pass left HRV off the glance because Chris's
   * original spec listed steps/calories/HR/SpO2/sleep and nothing else, and the
   * return doc flagged the absence as deliberate rather than an oversight. He
   * revised the spec on review: HRV gets a line alongside the others.
   */
  hrv: MetricSummary;
  sleep: SleepSummary | null;
};

const NO_DATA: MetricSummary = { min: 0, max: 0, avg: 0, hasData: false };

function summarise(samples: readonly HealthSample[], metric: SampleMetric): MetricSummary {
  const rolled = rollupOf(samples.filter((sample) => sample.metric === metric));
  if (!rolled) return NO_DATA;
  return { min: rolled.min, max: rolled.max, avg: rolled.avg, hasData: true };
}

function sumOf(samples: readonly HealthSample[], metric: SampleMetric): number {
  let total = 0;
  for (const sample of samples) if (sample.metric === metric) total += sample.total;
  return total;
}

/**
 * Everything the glasses glance shows, for one local day.
 *
 * `sleepSessions` is searched for the night that ENDED on this day - the
 * "last night's sleep" a morning glance means. A session is attributed to its
 * wake-up day on ingest (`SleepSession.dayStartMs`), so this is a lookup, not
 * a heuristic applied here.
 */
export function dailySummary(
  samples: readonly HealthSample[],
  sleepSessions: readonly SleepSession[],
  dayStartMs: number,
): DailySummary {
  const dayEndMs = nextBucketStart(dayStartMs, "day");
  const inDay = samples.filter(
    (sample) => sample.startMs >= dayStartMs && sample.startMs < dayEndMs,
  );
  const night = sleepSessions
    .filter((session) => session.dayStartMs === dayStartMs)
    .sort((a, b) => b.totalSec - a.totalSec)[0];
  return {
    dayStartMs,
    steps: Math.round(sumOf(inDay, "steps")),
    calories: Math.round(sumOf(inDay, "calories")),
    heartRate: summarise(inDay, "heartRate"),
    spo2: summarise(inDay, "spo2"),
    hrv: summarise(inDay, "hrv"),
    sleep: night ? sleepSummary(night) : null,
  };
}

// ===========================================================================
// Sleep

export type SleepSummary = {
  totalSec: number;
  /** Whole hours and remaining minutes of `totalSec`, for "6h 42m". */
  hours: number;
  minutes: number;
  wakeSec: number;
  /** Percentages OF TOTAL SLEEP TIME, from the record's named totals. */
  remPercent: number;
  lightPercent: number;
  deepPercent: number;
  /**
   * `total_time / (total_time + wake_time)`, as a percentage.
   *
   * This is sleep efficiency as the AASM's actigraphy scoring defines it -
   * time asleep over time in bed - and it is a decades-old published standard,
   * not something invented here. It is the one number added beyond Chris's
   * stated spec, and it is included precisely because it is the opposite of
   * the thing that was ruled out: it has a definition anyone can look up.
   *
   * Deliberately NOT here: a single 0-100 "sleep quality" score. Every
   * consumer wearable has one, none of them publish the blend, and there is no
   * generally-accepted formula - so it would be a number with the authority of
   * a measurement and the content of an opinion. Stage percentages and
   * efficiency are shown as themselves instead.
   */
  efficiencyPercent: number;
  /** Hypnogram bands, in display order. Empty when the record had no segments. */
  stageBands: readonly SleepStageBand[];
  /** False when the session could not be anchored to real wall-clock time. */
  timeResolved: boolean;
};

export type SleepStageBand = {
  stage: SleepStageName;
  seconds: number;
  /** Share of total-time-in-bed (sleep + wake), so the bands sum to 100%. */
  percentOfBed: number;
};

export function sleepSummary(session: SleepSession): SleepSummary {
  const total = Math.max(0, session.totalSec);
  const wake = Math.max(0, session.wakeSec);
  const inBed = total + wake;
  const pctOfSleep = (value: number): number => (total > 0 ? (value / total) * 100 : 0);
  const bedSeconds: Record<SleepStageName, number> = {
    wake,
    rem: Math.max(0, session.remSec),
    light: Math.max(0, session.lightSec),
    deep: Math.max(0, session.deepSec),
  };
  return {
    totalSec: total,
    hours: Math.floor(total / 3600),
    minutes: Math.round((total % 3600) / 60),
    wakeSec: wake,
    remPercent: pctOfSleep(session.remSec),
    lightPercent: pctOfSleep(session.lightSec),
    deepPercent: pctOfSleep(session.deepSec),
    efficiencyPercent: inBed > 0 ? (total / inBed) * 100 : 0,
    stageBands: STAGE_DISPLAY_ORDER.map((stage) => ({
      stage,
      seconds: bedSeconds[stage],
      percentOfBed: inBed > 0 ? (bedSeconds[stage] / inBed) * 100 : 0,
    })),
    timeResolved: session.timeResolved,
  };
}

/**
 * One stage's seconds, from the summary's own bands.
 *
 * Both surfaces label a stage lane with its duration, and both must take that
 * number from the record's NAMED per-stage fields (which `sleepSummary` already
 * resolved into `stageBands`) rather than by summing the hypnogram's blocks.
 * The two should agree; when they do not it is the segment array that is
 * suspect, because summing blocks depends on the stage-id mapping and the named
 * fields do not. See `sleep-stages.ts`.
 */
export function stageSeconds(stage: SleepStageName, summary: SleepSummary): number {
  return summary.stageBands.find((band) => band.stage === stage)?.seconds ?? 0;
}

/**
 * One entry per day in the window, carrying that night's four stage totals.
 *
 * Built for the diverging nightly chart (deep/REM/light stacked up, awake
 * down). Like `rollupSeries`, the grid is laid out first and then filled, so a
 * night with no record comes back as `hasData: false` at its real position
 * rather than shifting every later night one column left.
 *
 * Two sessions attributed to the same day are SUMMED rather than the longest
 * winning. That differs from `dailySummary`, which picks the longest because it
 * is answering "how did you sleep last night" with one headline number; here
 * the column is the day's total time in each stage, and dropping a nap would
 * make the bar disagree with the sleep total shown beside it.
 */
export function sleepNights(
  sessions: readonly SleepSession[],
  startMs: number,
  endMs: number,
): SleepNight[] {
  const byDay = new Map<number, SleepNight>();
  for (const session of sessions) {
    if (session.dayStartMs < startMs || session.dayStartMs >= endMs) continue;
    const entry = byDay.get(session.dayStartMs) ?? {
      startMs: session.dayStartMs,
      hasData: true,
      deepSec: 0,
      remSec: 0,
      lightSec: 0,
      wakeSec: 0,
    };
    entry.deepSec += Math.max(0, session.deepSec);
    entry.remSec += Math.max(0, session.remSec);
    entry.lightSec += Math.max(0, session.lightSec);
    entry.wakeSec += Math.max(0, session.wakeSec);
    byDay.set(session.dayStartMs, entry);
  }

  const nights: SleepNight[] = [];
  let cursor = startOfLocalDay(startMs);
  let guard = 0;
  while (cursor < endMs && guard < 4000) {
    guard += 1;
    nights.push(
      byDay.get(cursor) ?? {
        startMs: cursor,
        hasData: false,
        deepSec: 0,
        remSec: 0,
        lightSec: 0,
        wakeSec: 0,
      },
    );
    cursor = nextBucketStart(cursor, "day");
  }
  return nights;
}

/**
 * The hypnogram: the night as a run of stage blocks, in order.
 *
 * This is the ONE thing that depends on the raw stage-id mapping, which is why
 * it is separated from `sleepSummary`'s percentages (those come from named
 * fields and are unaffected). A segment whose id is not in the mapping is
 * returned with `stage: null` rather than dropped or guessed at.
 */
export function hypnogram(session: SleepSession): { stage: SleepStageName | null; seconds: number }[] {
  return session.segments.map((segment) => ({
    stage: stageNameForId(segment.stageId),
    seconds: segment.halfMinutes * 30,
  }));
}

/**
 * Date formatting, done by hand.
 *
 * ⚠ MEASURED, not a preference: `toLocaleDateString(undefined, { weekday:
 * "short" })` in this NativeScript Android runtime IGNORES the options bag and
 * returns the full `Fri Sep 04 2026`. It is the usual cause - a JS engine
 * built without full ICU quietly falls back instead of failing - and it turned
 * a week chart's axis into seven overlapping full dates. Anything that needs a
 * specific date shape has to build it, so these are the only date formatters
 * either surface uses.
 *
 * The cost is that they are English-only. That is a real limitation and the
 * right place to fix it is the runtime's ICU, not here.
 */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** "Fri". */
export function shortWeekday(ms: number): string {
  return WEEKDAYS[new Date(ms).getDay()] ?? "";
}

/** "Thu 10 Sep". */
export function shortDate(ms: number): string {
  const date = new Date(ms);
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** "6h 42m", or "--" when there is nothing to show. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** One decimal at most, and never a trailing ".0". */
export function formatValue(value: number, metric: SampleMetric): string {
  if (!Number.isFinite(value)) return "--";
  if (isCumulative(metric)) return `${Math.round(value)}`;
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

/**
 * Whether a metric's min/max band is worth drawing.
 *
 * Measured against the real export before this was written: heart rate's
 * hourly min and max differ in 98% of buckets, but SpO2's and HRV's are
 * IDENTICAL in 97% of them - the ring reports what amounts to a single reading
 * per hour for those two. Drawing a band there produces a hairline that reads
 * as a rendering fault rather than as "there is no spread", so the charts drop
 * to a plain line when the spread is degenerate across the window.
 */
export function bandIsMeaningful(points: readonly RollupPoint[]): boolean {
  let withData = 0;
  let withSpread = 0;
  for (const point of points) {
    if (point.count === 0) continue;
    withData += 1;
    if (point.max > point.min) withSpread += 1;
  }
  if (withData === 0) return false;
  return withSpread / withData >= 0.25;
}
