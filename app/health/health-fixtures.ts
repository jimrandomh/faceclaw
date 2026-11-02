/**
 * SAMPLE DATA. Not a capture, not anybody's health history.
 *
 * Every number below is generated from a seeded PRNG against hand-written
 * ranges. Nothing here was copied out of an export. What WAS taken from the
 * real export - by reading it, which is all this needed - is the *shape*:
 *
 *   - heart rate, SpO2 and HRV arrive as HOURLY buckets carrying (avg, max,
 *     min); steps and calories as TEN-MINUTE buckets; sleep once per session.
 *   - heart rate's hourly min and max genuinely differ (they were equal in
 *     about 2% of real buckets), but SpO2's and HRV's are equal in about 97%
 *     of theirs - the ring effectively reports one reading an hour for those
 *     two. The generator reproduces that, because a chart that assumes a
 *     spread everywhere looks broken on the two metrics that do not have one.
 *   - roughly a third of a day's ten-minute step buckets are non-zero; the
 *     rest are flat, because people sit still.
 *   - a night is a handful of hours with a majority in light sleep, a smaller
 *     REM share, a smaller deep share again, and a short wake total.
 *
 * The ranges are round numbers chosen to sit in the same neighbourhood as
 * those shapes, not measured constants, and the seed is fixed so a screenshot
 * taken today matches one taken next week.
 *
 * `seedFixtures()` also drops a marker file, and both surfaces show a "Sample
 * data" badge whenever it is present - so a screenshot of this can never be
 * mistaken later for a screenshot of a real sync.
 */

import {
  DAY_MS,
  HOUR_MS,
  TEN_MINUTES_MS,
  type HealthSample,
  type SleepSession,
  type SleepSegment,
  startOfLocalDay,
} from "./health-types";

/** Bumped whenever the generator changes, so a reseed replaces old fixtures. */
export const FIXTURE_VERSION = 1;

/** Deterministic, tiny, and good enough for plausible-looking noise. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function between(random: () => number, low: number, high: number): number {
  return low + random() * (high - low);
}

/**
 * A daily activity curve: near-nothing overnight, a morning rise, a dip after
 * lunch, an evening peak. Returns roughly 0..1 for an hour of the day.
 */
function activityCurve(hour: number): number {
  if (hour < 6) return 0.03;
  if (hour < 9) return 0.45;
  if (hour < 12) return 0.7;
  if (hour < 14) return 0.5;
  if (hour < 18) return 0.75;
  if (hour < 21) return 0.9;
  return 0.25;
}

export type Fixtures = {
  samples: HealthSample[];
  sleep: SleepSession[];
};

/**
 * Generate `days` days of sample data ending with today (partially filled up
 * to `nowMs`, so "today so far" looks like a day in progress rather than a
 * complete one).
 */
export function buildFixtures(options: { days: number; nowMs: number; seed?: number }): Fixtures {
  const { days, nowMs } = options;
  const random = mulberry32(options.seed ?? 0x5eed);
  const samples: HealthSample[] = [];
  const sleep: SleepSession[] = [];
  const today = startOfLocalDay(nowMs);

  for (let dayOffset = days - 1; dayOffset >= 0; dayOffset -= 1) {
    const dayStart = startOfLocalDay(today - dayOffset * DAY_MS);
    // A per-day baseline so consecutive days are not interchangeable.
    const restingBase = between(random, 56, 66);
    const hrvBase = between(random, 32, 55);
    const spo2Base = between(random, 96, 98);

    for (let hour = 0; hour < 24; hour += 1) {
      const bucketStart = dayStart + hour * HOUR_MS;
      if (bucketStart > nowMs) break;
      const effort = activityCurve(hour);

      // Heart rate: a real spread every hour.
      const avg = restingBase + effort * between(random, 10, 34);
      const spread = 4 + effort * between(random, 6, 26);
      samples.push({
        metric: "heartRate",
        startMs: bucketStart,
        spanMs: HOUR_MS,
        min: Math.round(avg - spread * between(random, 0.35, 0.6)),
        max: Math.round(avg + spread * between(random, 0.5, 0.9)),
        avg: Math.round(avg),
        total: Math.round(avg),
      });

      // SpO2 and HRV: one reading an hour most of the time, so min == max.
      const spo2 = Math.round(spo2Base + between(random, -2, 1.4));
      const spo2Flat = random() < 0.97;
      samples.push({
        metric: "spo2",
        startMs: bucketStart,
        spanMs: HOUR_MS,
        min: spo2Flat ? spo2 : spo2 - 1,
        max: spo2Flat ? spo2 : spo2 + 1,
        avg: spo2,
        total: spo2,
      });

      const hrv = Math.round(Math.max(6, hrvBase + between(random, -14, 18) - effort * 8));
      const hrvFlat = random() < 0.97;
      samples.push({
        metric: "hrv",
        startMs: bucketStart,
        spanMs: HOUR_MS,
        min: hrvFlat ? hrv : Math.max(2, hrv - 4),
        max: hrvFlat ? hrv : hrv + 5,
        avg: hrv,
        total: hrv,
      });

      // Steps and calories: six ten-minute buckets inside this hour.
      for (let slot = 0; slot < 6; slot += 1) {
        const bucket = bucketStart + slot * TEN_MINUTES_MS;
        if (bucket > nowMs) break;
        const moving = random() < effort * 0.55;
        const steps = moving ? Math.round(between(random, 20, 430) * effort) : 0;
        const resting = Math.round(between(random, 10, 13));
        const active = Math.round(steps * between(random, 0.03, 0.05));
        samples.push({
          metric: "steps",
          startMs: bucket,
          spanMs: TEN_MINUTES_MS,
          min: steps,
          max: steps,
          avg: steps,
          total: steps,
        });
        samples.push({
          metric: "calories",
          startMs: bucket,
          spanMs: TEN_MINUTES_MS,
          min: resting + active,
          max: resting + active,
          avg: resting + active,
          total: resting + active,
        });
      }
    }

    sleep.push(buildNight(random, dayStart));
  }

  return { samples, sleep };
}

/**
 * One night, attributed to the morning it ended on (`dayStart`).
 *
 * Built SEGMENTS FIRST, then the five duration totals summed out of them -
 * the same direction a real record is consistent in. The decode found four
 * arithmetic identities holding exactly on every real session, including
 * `sum(half_minutes) * 30 == total_time + wake_time` and a per-stage sum
 * matching each named total. Generating the totals first and the segments
 * afterwards cannot satisfy those exactly once rounding is involved, so this
 * goes the other way and the identities hold by construction.
 */
function buildNight(random: () => number, dayStart: number): SleepSession {
  const inBedHalfMinutes = Math.round(between(random, 4.4, 6.6) * 120);
  const bedMs = dayStart - inBedHalfMinutes * 30 * 1000;
  const segments = buildSegments(random, inBedHalfMinutes);

  const perStage = new Map<number, number>();
  for (const segment of segments) {
    perStage.set(segment.stageId, (perStage.get(segment.stageId) ?? 0) + segment.halfMinutes);
  }
  const seconds = (stageId: number): number => (perStage.get(stageId) ?? 0) * 30;
  const wakeSec = seconds(0);
  const remSec = seconds(1);
  const lightSec = seconds(2);
  const deepSec = seconds(3);
  const totalSec = remSec + lightSec + deepSec;

  return {
    dayStartMs: dayStart,
    startMs: bedMs,
    endMs: bedMs + (totalSec + wakeSec) * 1000,
    totalSec,
    wakeSec,
    remSec,
    lightSec,
    deepSec,
    segments,
    timeResolved: true,
  };
}

/**
 * A segment run filling exactly `inBedHalfMinutes`, cycling through the stages
 * the way a night does: light, deep, light, REM, and the occasional wake block.
 *
 * Stage ids are the RAW ring ids (0 wake, 1 REM, 2 light, 3 deep). The fixture
 * deliberately emits ids rather than friendly names, so anything downstream
 * that forgets to resolve them through `stageNameForId` is wrong here too.
 *
 * The per-stage weights are what produce a plausible mix - light dominant,
 * then deep, then REM, with a small wake share - matching the ordering the
 * real export shows without reproducing its numbers.
 */
function buildSegments(random: () => number, inBedHalfMinutes: number): SleepSegment[] {
  const cycle = [2, 3, 2, 1, 2, 0];
  const typicalLength: Record<number, [number, number]> = {
    0: [1, 6],
    1: [8, 26],
    2: [14, 40],
    3: [10, 30],
  };
  const segments: SleepSegment[] = [];
  let remaining = inBedHalfMinutes;
  let index = 0;
  while (remaining > 0) {
    const stage = cycle[index % cycle.length]!;
    index += 1;
    const [low, high] = typicalLength[stage]!;
    const take = Math.min(remaining, Math.max(1, Math.round(between(random, low, high))));
    segments.push({ stageId: stage, halfMinutes: take });
    remaining -= take;
  }
  return segments;
}
