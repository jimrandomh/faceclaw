/**
 * Wire records -> stored samples. The one place that knows what the ring's
 * decoded records mean in wall-clock terms.
 *
 * ## This is written but NOT wired up, on purpose
 *
 * The live BLE path lives on the `ring-health-protocol` branch, which this one
 * deliberately does not touch. What is here is the whole conversion - the part
 * with the judgement calls in it - written against a structural description of
 * `RingProtocol.java`'s record types rather than an import of them, so that
 * branch and this one can be joined later without either having been built
 * around the other.
 *
 * ## WHERE THE LIVE WIRING GOES - the follow-up, in full
 *
 * ⚠ HISTORICAL. This section is the plan, and it has since been built:
 * `health-live.ts` is the caller. One detail of it is now WRONG - the live path
 * must NOT use `getRingHealthRecords()`, which is a pure copy and left the
 * Java-side buffer growing forever. It uses `takeRingHealthBatch()` and hands
 * the records back with `clearRingHealthRecordsBelow()` once the store write
 * has succeeded. Kept below for the reasoning, not as instructions.
 *
 * `FaceclawBleCommunicator` already accumulates decoded records into a capped
 * in-memory list with a `getRingHealthRecords()` getter (implement-return,
 * section 2). The bridge already exposes the native object to TypeScript:
 * `FaceclawCommunicatorBridge.getNativeCommunicator()`. So the follow-up is:
 *
 *   1. In `dashboard-controller.ts`, after `connect()` succeeds, poll
 *      `communicator.getNativeCommunicator().getRingHealthRecords()` on the
 *      same 30-minute cadence the Java side already throttles health pulls to.
 *   2. Map each Java record onto the `Wire*` shapes below - a field-for-field
 *      copy; the names were chosen to match.
 *   3. Hand the result to `convertRecords()` and pass its `samples`/`sleep`
 *      straight to `healthStore().ingestSamples()` / `.ingestSleep()`.
 *
 * Doing it as a poll rather than a callback is what keeps it a small change:
 * adding a method to `FaceclawBleCommunicatorListener` forces an edit on every
 * implementer, which is exactly the reasoning that put the records in a getter
 * in the first place.
 *
 * A note for whoever does it: ingest is idempotent (`HealthStore` dedupes on
 * metric + bucket start), so re-reading the same capped list every poll is
 * correct and costs one no-op per record. Do NOT drain the list on read - it
 * is the only copy until this store has written it.
 *
 * No NativeScript imports here, so it runs under plain node in `tests/`.
 */

import {
  HOUR_MS,
  TEN_MINUTES_MS,
  type HealthSample,
  type SleepSession,
  type SleepSegment,
  startOfLocalDay,
} from "./health-types";

/** `RingProtocol.HourlyRecord`, for heart rate (`01:01`), SpO2 (`02:01`), HRV (`04:01`). */
export type WireHourlyRecord = {
  kind: "hourly";
  metric: "heartRate" | "spo2" | "hrv";
  /**
   * Absolute local ms the page's group index 0 refers to, from the record's
   * own six-byte ANCHOR field, or null on a backlog page that carried six
   * zero bytes instead.
   */
  anchorMs: number | null;
  groups: readonly { hourIndex: number; avg: number; max: number; min: number }[];
};

/** `RingProtocol.StepsRecord` (`05:01`). */
export type WireStepsRecord = {
  kind: "steps";
  /** The day anchor. Steps pages always carried one in the capture. */
  anchorMs: number | null;
  /** Raw buckets. `index` is the ring's own, whose meaning is NOT known. */
  buckets: readonly { index: number; steps: number; activeCalories: number; totalCalories: number }[];
};

/** `RingProtocol.SleepRecord` (`06:01`). */
export type WireSleepRecord = {
  kind: "sleep";
  /**
   * The ring's own `start_ts`/`end_ts`, in seconds.
   *
   * These were documented here as "ring-relative seconds - NOT Unix time",
   * because nothing in the offline capture proved otherwise. The first real
   * record off the hardware (2026-09-12) falsified that: `start_ts` decodes to
   * a plain Unix timestamp kept on the RING'S clock, which runs ahead of real
   * time. `clockCorrectionMs` is how a caller says by how much.
   *
   * Left as raw seconds here rather than corrected upstream so a caller with
   * no correction to offer (an offline capture, a fixture) still gets the old,
   * honestly-unresolved behaviour instead of a confidently wrong date.
   */
  startTs: number;
  endTs: number;
  totalSec: number;
  wakeSec: number;
  remSec: number;
  lightSec: number;
  deepSec: number;
  segments: readonly SleepSegment[];
  /** Wall-clock ms the record was received; the only real time in it. */
  receivedAtMs: number;
  /**
   * How far AHEAD of real wall-clock time `startTs`/`endTs` run, in ms, or
   * omitted when the caller cannot say. Supplying it is what promotes the
   * session from `timeResolved: false` to a real placement - see
   * `convertSleep`. The value itself is the producer's problem, not this
   * module's: see `sleepClockCorrectionMs` in `health-live.ts`.
   */
  clockCorrectionMs?: number;
};

export type WireRecord = WireHourlyRecord | WireStepsRecord | WireSleepRecord;

export type ConversionResult = {
  samples: HealthSample[];
  sleep: SleepSession[];
  /** Every record or group deliberately not stored, with the reason. */
  skipped: { what: string; why: string }[];
};

export function convertRecords(records: readonly WireRecord[]): ConversionResult {
  const result: ConversionResult = { samples: [], sleep: [], skipped: [] };
  for (const record of records) {
    if (record.kind === "hourly") convertHourly(record, result);
    else if (record.kind === "steps") convertSteps(record, result);
    else convertSleep(record, result);
  }
  return result;
}

/**
 * Hourly pages. An ANCHORED page dates itself exactly: group `i` is
 * `anchor + i hours`, which the decode verified against every group that had a
 * row to check against.
 *
 * An UNANCHORED (backlog) page is dropped rather than placed. The decode did
 * solve where one such page landed, but explicitly could not derive the rule
 * that produced it and warned that a future page anchored elsewhere would
 * break it. `RingProtocol.java` already made the matching call - it hands
 * backlog groups out with `UNKNOWN_TIME` rather than an invented time - and a
 * health chart is exactly the wrong place to be the first component that
 * guesses. Dropping loses a page; guessing corrupts the history silently.
 */
function convertHourly(record: WireHourlyRecord, result: ConversionResult): void {
  if (record.anchorMs === null) {
    result.skipped.push({
      what: `${record.metric} page, ${record.groups.length} groups`,
      why: "backlog page with no anchor - no verified rule for dating it",
    });
    return;
  }
  for (const group of record.groups) {
    const startMs = record.anchorMs + group.hourIndex * HOUR_MS;
    result.samples.push({
      metric: record.metric,
      startMs,
      spanMs: HOUR_MS,
      min: group.min,
      max: group.max,
      avg: group.avg,
      total: group.avg,
    });
  }
}

/**
 * Steps and calories, at TEN-MINUTE resolution.
 *
 * ## The index is cracked (2026-09-12)
 *
 * This used to emit one day-span sample holding the day's total, because the
 * bucket index was only trusted as an identity, not as a time. It now resolves:
 * **bucket `i` starts at `anchor + i * 10 minutes`**, with the anchor read
 * offset-corrected like every other record type.
 *
 * Confirmed twice. The decisive check: a live ledger held 25 contiguous buckets
 * (1-25) under a corrected anchor of 20:00, while the file's mtime was 00:18
 * local - and `20:00 + 25 * 10min` is 00:10-00:20, which is the window that was
 * actually being filled. The older "index runs 0-34 then jumps to 130-132"
 * observation came from an offline capture spanning more than one ring-day;
 * indices are per-record and contiguous within one.
 *
 * ## What this changes downstream
 *
 * The day total is no longer readable off any field of a day's rollup - it is
 * `sum`, and only `sum`, because `count` is now ~144 rather than 1. Checked on
 * 2026-09-12: every steps/calories reader already uses the summing path
 * (`dailySummary` -> `sumOf` -> `sample.total`; `rollupSeries` -> `rollupOf` ->
 * `sum`; the phone view model's steps branch reads `point.sum`), so nothing had
 * to change for this. Do not add a reader that takes `max` or `avg` for a step
 * total.
 *
 * A ring-day starts at 20:00 local (the ring's clock runs 4h fast, so its
 * midnight is our 20:00), which means one record's buckets straddle two
 * calendar days. That is correct and is the reason the day figure moves when
 * this lands: the evening buckets stop being filed under tomorrow.
 */
function convertSteps(record: WireStepsRecord, result: ConversionResult): void {
  if (record.anchorMs === null) {
    result.skipped.push({
      what: `steps page, ${record.buckets.length} buckets`,
      why: "no anchor - cannot date the buckets",
    });
    return;
  }
  const anchorMs = record.anchorMs;
  for (const bucket of record.buckets) {
    const startMs = anchorMs + bucket.index * TEN_MINUTES_MS;
    result.samples.push({
      metric: "steps",
      startMs,
      spanMs: TEN_MINUTES_MS,
      min: bucket.steps,
      max: bucket.steps,
      avg: bucket.steps,
      total: bucket.steps,
    });
    result.samples.push({
      metric: "calories",
      startMs,
      spanMs: TEN_MINUTES_MS,
      min: bucket.totalCalories,
      max: bucket.totalCalories,
      avg: bucket.totalCalories,
      total: bucket.totalCalories,
    });
  }
}

/**
 * Sleep sessions.
 *
 * The durations are exact and need no anchoring - they come from named byte
 * offsets and the decode reproduced a whole exported row from them. The
 * SESSION TIME is the problem: `start_ts`/`end_ts` are ring-relative seconds,
 * nothing in the record carries an absolute date, and the two unidentified
 * fields that might have carried one were not cracked. Even's own app gets
 * this wrong - one exported row is stamped 1979.
 *
 * RESOLVED, 2026-09-12, by the first real record off the hardware rather than
 * by cracking `pay[3:9]`: `start_ts` is already a Unix timestamp, just kept on
 * the ring's own clock. A caller that knows how far that clock runs ahead
 * passes `clockCorrectionMs` and gets a genuinely placed session.
 *
 * ⚠ THE OLD FLAGGED GUESS SURVIVES for callers that do NOT pass it (offline
 * captures, fixtures): the session is attributed to the local day it was
 * RECEIVED on and `timeResolved` is false to say so. That guess is made rather
 * than avoided because "last night's sleep" is half of what the glasses glance
 * is for, and a record with no day at all cannot appear there. It is right
 * whenever the ring is synced the same day it is worn and wrong for a backlog
 * session pulled days later - which is why the UI never prints a date for an
 * unresolved session, only "last night", and shows the unresolved marker.
 */
function convertSleep(record: WireSleepRecord, result: ConversionResult): void {
  const durationSec = Math.max(0, record.endTs - record.startTs);
  const common = {
    totalSec: record.totalSec,
    wakeSec: record.wakeSec,
    remSec: record.remSec,
    lightSec: record.lightSec,
    deepSec: record.deepSec,
    segments: record.segments,
  };

  if (typeof record.clockCorrectionMs === "number") {
    const startMs = record.startTs * 1000 - record.clockCorrectionMs;
    const endMs = (record.startTs + durationSec) * 1000 - record.clockCorrectionMs;
    result.sleep.push({
      // The WAKE-UP day, which is what `dailySummary` looks a night up by, and
      // what the old receivedAtMs guess was approximating. Taken from the end
      // of the session so a night that starts before midnight still belongs to
      // the morning it ends on.
      dayStartMs: startOfLocalDay(endMs),
      startMs,
      endMs,
      ...common,
      timeResolved: true,
    });
    return;
  }

  result.sleep.push({
    dayStartMs: startOfLocalDay(record.receivedAtMs),
    // Raw seconds are kept as-is so the pair still describes the night's
    // length and ordering; `timeResolved` is what says not to read them as
    // wall-clock time.
    startMs: record.startTs * 1000,
    endMs: (record.startTs + durationSec) * 1000,
    ...common,
    timeResolved: false,
  });
}

/**
 * The consistency check the decode found holds on every real record: the
 * segment run must account for exactly the time in bed. Worth running on
 * ingest - a record that fails it is a decode fault, not a strange night.
 */
export function sleepIdentityHolds(record: {
  totalSec: number;
  wakeSec: number;
  segments: readonly SleepSegment[];
}): boolean {
  let half = 0;
  for (const segment of record.segments) half += segment.halfMinutes;
  return half * 30 === record.totalSec + record.wakeSec;
}
