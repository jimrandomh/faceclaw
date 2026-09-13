/**
 * Live ring → store. The producer side of `health-ingest.ts`.
 *
 * `health-ingest.ts` was built with a complete wire→domain conversion and no
 * caller; this is the caller. It reads whatever `FaceclawBleCommunicator` has
 * decoded off the ring this session, marshals the Java records into the
 * `WireRecord` shapes that module already expects, and writes the result
 * through the store's own deduping ingest.
 *
 * Three things worth knowing:
 *
 * 1. **It pulls, it does not subscribe, and it CONSUMES.** There is no push
 *    event for health records, so both surfaces call this when they open and on
 *    their existing refresh tick. `takeRingHealthBatch()` hands over what the
 *    communicator is holding together with a watermark, and once the store
 *    write has succeeded `clearRingHealthRecordsBelow()` hands that much back
 *    as consumed. Cut and paste, not copy paste.
 *
 *    It used to be a pure copy, and nothing ever cleared the Java-side list, so
 *    every 60s tick re-processed the whole session's history. Measured
 *    2026-09-12: `samples-2026-09.jsonl` grew 22,505 -> 28,552 lines in eight
 *    hours, the buffer climbing 12 -> 24 records and samples-written-per-cycle
 *    8 -> 14. The store's dedupe kept the DATA right the whole time; it was the
 *    work and the file that grew without bound.
 *
 * 2. **Fixtures are purged, not just unlabelled, before the first real write.**
 *    `clearFixtureMarker()` only drops the badge; the 45 days of generated
 *    samples would stay in the store and become indistinguishable from real
 *    data the moment the badge went away. That is precisely the artefact
 *    `health-seed.ts`' own header warns about, so the first genuine record
 *    wipes the store files outright.
 *
 * 3. **Records the decode could not date are dropped, not placed.**
 *    `RingProtocol` hands out `UNKNOWN_TIME` (-1) for an unanchored backlog
 *    page rather than inventing a time; that maps to `anchorMs: null` here and
 *    `convertRecords` skips it with a reason. Do not "fix" this by substituting
 *    now() — a health chart is the wrong place to guess a timestamp.
 */

import {
  convertRecords,
  type WireHourlyRecord,
  type WireRecord,
  type WireSleepRecord,
  type WireStepsRecord,
} from "./health-ingest";
import { markLiveData, purgeFixtureData } from "./health-seed";
import { healthStore } from "./health-store-files";
import { startOfLocalDay, type SleepSegment } from "./health-types";
import { File, knownFolders } from "@nativescript/core";

/** `RingProtocol.UNKNOWN_TIME` — the decoder's "I will not guess" sentinel. */
const UNKNOWN_TIME = -1;

/** `RingProtocol.CMD_HI_*`. */
const CMD_HEART_RATE = 0x01;
const CMD_SPO2 = 0x02;
const CMD_HRV = 0x04;
const CMD_STEPS = 0x05;
const CMD_SLEEP = 0x06;

/** `SleepRecord.recordState`: 2 is the empty end-of-list marker, not a night. */
const SLEEP_STATE_EMPTY = 2;

const HOURLY_METRIC: { [cmdHi: number]: WireHourlyRecord["metric"] } = {
  [CMD_HEART_RATE]: "heartRate",
  [CMD_SPO2]: "spo2",
  [CMD_HRV]: "hrv",
};

function activeCommunicator(): any {
  try {
    return (com as any).faceclaw.app.FaceclawBleCommunicator.getActive() ?? null;
  } catch {
    return null;
  }
}

/**
 * The ring timestamps in a frame 4 hours ahead of real time, and that is our
 * own doing: the handshake sets its clock to `now + 14400s`, because that is
 * what a real Even write carries (verified against six of them). Even's app
 * evidently subtracts the same offset on the way back out. We were not, so
 * every hourly sample landed 4 hours in the future.
 *
 * MEASURED, not theorised. Stored samples read 09:00/10:00/11:00 local while
 * the actual time was 07:15; minus four hours gives 05:00/06:00/07:00, which
 * is exactly right for a ring that had just reported the current hour.
 *
 * ⚠ This value is PAIRED with the offset in `sendRingHandshake()`. They must
 * move together.
 *
 * Both were hardcoded to 14400. As of 2026-09-12 both COMPUTE it: 14400 was
 * only ever right because every capture behind this work was taken in EDT,
 * where 14400s is the magnitude of the UTC offset. Computing it is identical
 * today and survives DST.
 *
 * ⚠ MIND THE SIGN. The quantity is "how far AHEAD of real time the ring's clock
 * runs", which is the magnitude of a west-of-UTC offset — positive 14400 in
 * EDT. `getTimezoneOffset()` is already minutes WEST of UTC (+240 in EDT), so
 * it is used as-is, NOT negated. Java's `TimeZone.getOffset()` uses the
 * opposite convention and is negated there; the two agree on +14400.
 *
 * Worth recording because the first cut of this change got the sign backwards
 * on both sides at once — consistently, so they stayed "paired", and still
 * wrong by 8 hours. Only the handshake's own assertion log caught it.
 *
 * Note this direction is the OPPOSITE of the "ring stores naive local time"
 * hypothesis (which predicts `epoch + utc_offset`, i.e. 4h behind). Measured
 * behaviour is 4h ahead. The hypothesis is unconfirmed; the measurement rules.
 */
function ringClockOffsetMs(atMs: number): number {
  return new Date(atMs).getTimezoneOffset() * 60 * 1000;
}

/**
 * Sleep timestamps need TWICE the correction the hourly samples need.
 *
 * ⚠ EMPIRICAL, AND THE MECHANISM IS UNEXPLAINED. Do not read a story into the
 * factor of 2. The last time this file invented a tidy explanation for a ring
 * clock quirk ("the ring stores naive local time") it was falsified the next
 * day, which is why the hourly comment above ends with "the measurement rules".
 * The same applies here, more so: nothing about a sleep record is known to
 * differ from an hourly one in how it is stamped, and yet the correction does.
 *
 * The evidence, 2026-09-12, the first real sleep record off the hardware:
 * `start_ts` decodes raw to 10:21:01 EDT. Chris confirmed the true window two
 * independent ways - he slept "straight through from around 1:30 AM to 9:30 AM",
 * and separately reported seeing only the first block with "another 4 or so
 * hours after that". Under -4h the block is 06:21 -> 09:25, which puts the
 * missing time BEFORE it and contradicts what the device showed. Under -8h it
 * is 02:21 -> 05:25, leaving 05:25 -> 09:30 (4h05m) missing AFTER it, which is
 * what he saw.
 *
 * Expressed as twice `ringClockOffsetMs` rather than a fresh 28800 so the
 * November DST change moves the hourly correction and this one together. Like
 * the hourly path it is evaluated at the RAW instant, so within ~8h of a DST
 * switch it can pick the wrong side by an hour - the same caveat, deliberately
 * kept identical rather than special-cased here.
 */
function sleepClockOffsetMs(atMs: number): number {
  return 2 * ringClockOffsetMs(atMs);
}

function anchorToMs(anchorUnixSeconds: number, applyClockOffset: boolean): number | null {
  if (anchorUnixSeconds === UNKNOWN_TIME) return null;
  const ms = anchorUnixSeconds * 1000;
  return applyClockOffset ? ms - ringClockOffsetMs(ms) : ms;
}

/**
 * Per-day step-bucket ledger.
 *
 * **Why this has to exist.** The ring does not resend the whole day: a pull
 * delivers only the buckets new since the last successful one, the same
 * watermark model every other record type uses. Measured 2026-09-11:
 * 25 buckets / 222 steps, then 3 / 0, then 2 / 0, then 2 / 70. A cumulative
 * day total cannot go 222 → 0 → 70.
 *
 * `convertSteps()` sums the buckets it is handed and emits that as the day's
 * total, which was right for the offline captures it was written against —
 * there, one sync carried everything. Live, it means each pull overwrites the
 * day with just that pull's increment, so the step count reads as "since the
 * last pull" and lurches downward. So this keeps the day's buckets and hands
 * `convertSteps()` the accumulated set, leaving that function pure.
 *
 * **Merge is max-by-index, not addition and not last-write-wins.** A bucket is
 * a time window's own total, so a window redelivered later carries a larger
 * value, not an increment to add — addition would double-count every open
 * window. Taking the max rather than the last value makes the merge
 * ORDER-INDEPENDENT, which matters because a single sync pass merges several
 * records that overlap: measured 2026-09-12, four steps records in one pass
 * agreed on every bucket's step count but disagreed on its calorie fields, so
 * last-write-wins made the day's calorie total ping-pong 643 ↔ 671 forever,
 * appending two lines to the sample shard every cycle. Max is consistent with
 * the documented model (a window's total only grows as it fills) and settles.
 *
 * **The ledger holds MANY days, not one.** It used to hold exactly one, and
 * kept it only while the incoming day matched — so the moment a record from
 * another ring-day arrived, the whole accumulated day was discarded and
 * rebuilt from that one pull. With `syncLiveRecords()` re-processing the
 * communicator's entire record history every 60s, that produced a repeating
 * cycle of partial sums, each written to the store as a genuine day total
 * (measured: a 12-state cycle, repeated 132 times, 22k lines in a day).
 * Holding every day makes the replay idempotent instead of destructive — and
 * no theory about WHY records replay is needed for that to hold.
 *
 * The day key is `startOfLocalDay(corrected anchor)`, which is the ring's own
 * day start, not calendar midnight — the ring's day begins at 20:00 local
 * because its clock runs 4h fast. That is fine: the key is an identity, and
 * the per-bucket timestamps carry the real wall-clock placement.
 */
type StepDayBuckets = { [index: string]: { steps: number; active: number; total: number } };

type StepBucketLedger = {
  /** `dayStartMs` (as a string key) -> that day's buckets. */
  days: { [dayStartMs: string]: StepDayBuckets };
};

/** The pre-2026-09-12 single-day shape, migrated on read rather than dropped. */
type LegacyStepBucketLedger = { dayStartMs: number; buckets: StepDayBuckets };

/** How many ring-days to keep. Enough for a weekly chart, bounded on disk. */
const LEDGER_DAYS_KEPT = 7;

function ledgerPath(): string {
  return `${knownFolders.documents().getFolder("health").path}/steps-ledger.json`;
}

function readLedger(): StepBucketLedger | null {
  try {
    if (!File.exists(ledgerPath())) return null;
    const parsed = JSON.parse(File.fromPath(ledgerPath()).readTextSync()) as
      | StepBucketLedger
      | LegacyStepBucketLedger;
    if (parsed && (parsed as StepBucketLedger).days) return parsed as StepBucketLedger;
    // Migrate the single-day shape rather than discarding it: the file on the
    // phone holds real step data the ring may not re-deliver.
    //
    // ⚠ RE-KEY IT. The legacy `dayStartMs` was `startOfLocalDay(RAW anchor)`,
    // computed before the anchor was offset-corrected, so carrying it across
    // verbatim files the day 4h too late — under a key the corrected code will
    // never write to again. The accumulated buckets would sit there stranded
    // while the same ring-day restarted empty beside them. Measured doing
    // exactly that on 2026-09-12: a ledger with "2 days" that were one day.
    const legacy = parsed as LegacyStepBucketLedger;
    if (typeof legacy?.dayStartMs === "number" && legacy.buckets) {
      const corrected = legacy.dayStartMs - ringClockOffsetMs(legacy.dayStartMs);
      return { days: { [String(startOfLocalDay(corrected))]: legacy.buckets } };
    }
    return null;
  } catch {
    return null;
  }
}

/** Keep the ledger bounded. Newest `LEDGER_DAYS_KEPT` days survive. */
function pruneLedger(ledger: StepBucketLedger): void {
  const keys = Object.keys(ledger.days).sort((a, b) => Number(b) - Number(a));
  for (const key of keys.slice(LEDGER_DAYS_KEPT)) delete ledger.days[key];
}

function writeLedger(ledger: StepBucketLedger): void {
  try {
    File.fromPath(ledgerPath()).writeTextSync(JSON.stringify(ledger));
  } catch (error) {
    console.warn("health live: steps ledger write failed", error);
  }
}

/** Merge this pull's buckets into that ring-day's ledger and return its full set. */
function accumulateStepBuckets(
  dayStartMs: number,
  delivered: readonly { index: number; steps: number; activeCalories: number; totalCalories: number }[],
): { index: number; steps: number; activeCalories: number; totalCalories: number }[] {
  const ledger: StepBucketLedger = readLedger() ?? { days: {} };
  const dayKey = String(dayStartMs);
  const day: StepDayBuckets = ledger.days[dayKey] ?? {};
  ledger.days[dayKey] = day;
  for (const bucket of delivered) {
    const existing = day[String(bucket.index)];
    // Max, not overwrite — see the type's header. Keeps the merge order-independent.
    day[String(bucket.index)] = {
      steps: Math.max(existing?.steps ?? 0, bucket.steps),
      active: Math.max(existing?.active ?? 0, bucket.activeCalories),
      total: Math.max(existing?.total ?? 0, bucket.totalCalories),
    };
  }
  pruneLedger(ledger);
  writeLedger(ledger);
  const merged = Object.keys(day).map((key) => ({
    index: Number(key),
    steps: day[key]!.steps,
    activeCalories: day[key]!.active,
    totalCalories: day[key]!.total,
  }));
  const steps = merged.reduce((acc, b) => acc + b.steps, 0);
  const calories = merged.reduce((acc, b) => acc + b.totalCalories, 0);
  console.log(
    `health live: steps ledger +${delivered.length} delivered -> ${merged.length} buckets held ` +
      `for ring-day ${new Date(dayStartMs).toISOString()}, ${steps} steps / ${calories} cal, ` +
      `${Object.keys(ledger.days).length} days in ledger`,
  );
  return merged;
}

function toWire(record: any): WireRecord | null {
  const cmdHi = Number(record.cmdHi);

  const metric = HOURLY_METRIC[cmdHi];
  if (metric) {
    const groups: { hourIndex: number; avg: number; max: number; min: number }[] = [];
    const raw = record.groups;
    for (let i = 0; i < raw.length; i++) {
      const group = raw[i];
      groups.push({
        hourIndex: Number(group.hourIndex),
        avg: Number(group.avg),
        max: Number(group.max),
        min: Number(group.min),
      });
    }
    return { kind: "hourly", metric, anchorMs: anchorToMs(Number(record.anchorUnixSeconds), true), groups };
  }

  if (cmdHi === CMD_STEPS) {
    const buckets: { index: number; steps: number; activeCalories: number; totalCalories: number }[] = [];
    const raw = record.buckets;
    for (let i = 0; i < raw.length; i++) {
      const bucket = raw[i];
      buckets.push({
        index: Number(bucket.index),
        steps: Number(bucket.steps),
        // UNVERIFIED MAPPING. The decode never resolved which of the record's
        // two calorie-like fields is active vs total burn, which is why the
        // Java side names them calorieLike2/calorieLike3 rather than committing.
        // convertSteps() sums totalCalories, so if the daily calorie figure
        // reads wrong against Even's own export, swap these two — that is the
        // whole fix, and it is the only thing here resting on a guess.
        activeCalories: Number(bucket.calorieLike2),
        totalCalories: Number(bucket.calorieLike3),
      });
    }
    // Offset-corrected like every other record type, as of 2026-09-12.
    //
    // This used to pass `false`, and the reasoning was that flooring the raw
    // anchor to the local day "absorbed" the 4h shift and landed on the right
    // date, where subtracting would push the day boundary back to 20:00 the
    // previous evening. That was solving the wrong problem. The anchor was
    // being asked to carry the DATE LABEL for a single day-blob sample, so it
    // had to be bent until the label came out right.
    //
    // With the bucket index cracked (bucket i starts at anchor + i*10min), the
    // anchor no longer carries a date at all — it is the true start instant of
    // bucket 0, and each bucket now dates itself. So the anchor must simply be
    // correct, and correct means offset-corrected: measured 2026-09-12 00:36,
    // the raw anchor read 00:00 today while the record's own 25 buckets place
    // the series start at 20:00 the previous evening, which is exactly the 4h.
    //
    // The ring's day really does begin at 20:00 local, because its clock runs
    // 4h fast and its day starts at ITS midnight. A ring-day therefore straddles
    // two calendar days, and the buckets land on whichever real day they fall
    // in — which is the point.
    const anchorMs = anchorToMs(Number(record.anchorUnixSeconds), true);
    if (anchorMs === null) return { kind: "steps", anchorMs: null, buckets };
    // Hand convertSteps() the whole day, not just this pull's increment.
    const accumulated = accumulateStepBuckets(startOfLocalDay(anchorMs), buckets);
    return { kind: "steps", anchorMs, buckets: accumulated };
  }

  if (cmdHi === CMD_SLEEP) {
    if (Number(record.recordState) === SLEEP_STATE_EMPTY) return null;
    const segments: SleepSegment[] = [];
    const raw = record.segments;
    for (let i = 0; i < raw.length; i++) {
      const segment = raw[i];
      // Java calls it `stage`, the domain type calls it `stageId` - both are
      // the same raw 0-3 ring id, deliberately unresolved here (see sleep-stages.ts).
      segments.push({ stageId: Number(segment.stage), halfMinutes: Number(segment.halfMinutes) });
    }
    const startTs = Number(record.startTs);
    const endTs = Number(record.endTs);
    const correction = sleepClockOffsetMs(startTs * 1000);
    // The assertion log for the -8h correction. One sleep record a night makes
    // this cheap, and a wrong clock frame is otherwise invisible until someone
    // reads a chart and disbelieves it.
    console.log(
      `health live: sleep raw ${new Date(startTs * 1000).toString()} -> corrected ` +
        `${new Date(startTs * 1000 - correction).toString()} .. ` +
        `${new Date(endTs * 1000 - correction).toString()} (-${correction / 3600000}h)`,
    );
    return {
      kind: "sleep",
      startTs,
      endTs,
      clockCorrectionMs: correction,
      totalSec: Number(record.totalTime),
      wakeSec: Number(record.wakeTime),
      remSec: Number(record.remTime),
      lightSec: Number(record.lightTime),
      deepSec: Number(record.deepTime),
      segments,
      receivedAtMs: Number(record.receivedAtMs),
    };
  }

  return null;
}

export type LiveSyncResult = {
  /** Records the communicator was holding. 0 means no pull has landed yet. */
  seen: number;
  /** Samples genuinely new to the store. */
  samplesWritten: number;
  /** Sleep sessions genuinely new to the store. */
  sleepWritten: number;
  /** Conversions deliberately declined, with reasons, from `convertRecords`. */
  skipped: { what: string; why: string }[];
};

const EMPTY: LiveSyncResult = { seen: 0, samplesWritten: 0, sleepWritten: 0, skipped: [] };

/**
 * Read the communicator's decoded records into the durable store.
 *
 * Safe to call on every open and every refresh: the store dedupes, and an
 * absent communicator (no glasses process, preview build) is a no-op rather
 * than an error.
 */
/**
 * Tell the communicator the snapshot is durably stored and may be dropped.
 *
 * Deliberately swallows its own failure: a clear that does not happen costs a
 * little growth, and there is nothing useful to do about it here. The bias runs
 * one way throughout - under-clearing is cheap, over-clearing loses data.
 */
function consumeUpTo(communicator: any, watermark: number): void {
  try {
    const dropped = Number(communicator.clearRingHealthRecordsBelow(watermark));
    if (dropped > 0) {
      console.log(`health live: consumed ${dropped} records (watermark ${watermark})`);
    }
  } catch (error) {
    console.warn("health live: could not clear consumed records", error);
  }
}

export function syncLiveRecords(): LiveSyncResult {
  const communicator = activeCommunicator();
  if (!communicator) return EMPTY;

  let batch: any;
  try {
    batch = communicator.takeRingHealthBatch();
  } catch (error) {
    console.warn("health live: could not read ring records", error);
    return EMPTY;
  }
  if (!batch) return EMPTY;
  const records = batch.getRecords();
  // Identifies exactly this snapshot. Anything the ring pushes from here on is
  // numbered above it and therefore cannot be cleared by this pass - which is
  // what keeps a page landing mid-ingest from being dropped.
  const watermark = Number(batch.getWatermark());
  if (!records || !records.size || records.size() === 0) return EMPTY;

  const wire: WireRecord[] = [];
  const size = records.size();
  for (let i = 0; i < size; i++) {
    try {
      const converted = toWire(records.get(i));
      if (converted) wire.push(converted);
    } catch (error) {
      console.warn("health live: skipped an undecodable record", error);
    }
  }
  if (wire.length === 0) return { ...EMPTY, seen: size };

  const { samples, sleep, skipped } = convertRecords(wire);
  if (samples.length === 0 && sleep.length === 0) {
    return { seen: size, samplesWritten: 0, sleepWritten: 0, skipped };
  }

  // First real data wins the store outright — see the header.
  purgeFixtureData();

  const store = healthStore();
  const samplesWritten = store.ingestSamples(samples);
  const sleepWritten = store.ingestSleep(sleep);
  if (samplesWritten > 0 || sleepWritten > 0) markLiveData();

  // ONLY here. Both store writes have returned, so the records are durable.
  // If either threw, or the process died above this line, nothing is cleared
  // and the same records arrive again next tick - which costs one repeated
  // ingest (a no-op, the store refuses identical re-writes) instead of losing
  // a night. Note `samplesWritten === 0` is NOT a failure: it means the store
  // already held all of it, which is the steady state this change creates.
  consumeUpTo(communicator, watermark);

  console.log(
    `health live: ${size} records -> ${samplesWritten} samples, ${sleepWritten} sleep` +
      (skipped.length ? `, ${skipped.length} skipped` : ""),
  );
  return { seen: size, samplesWritten, sleepWritten, skipped };
}

/**
 * Ask the ring for a fresh pull now, rather than waiting out the automatic
 * 30-minute cycle. Returns immediately; the pull itself takes ~15s on the
 * communicator's worker thread and lands through the next `syncLiveRecords()`.
 *
 * Throttled communicator-side to one a minute — see
 * `requestRingHealthNow()`. Calling it on every open is fine.
 */
export function requestFreshPull(): void {
  const communicator = activeCommunicator();
  if (!communicator) return;
  try {
    communicator.requestRingHealthNow();
  } catch (error) {
    console.warn("health live: on-demand pull request failed", error);
  }
}

/**
 * Keep decoded records reaching disk whether or not a surface is open.
 *
 * Without this, records live only in the communicator's memory until the
 * health app or phone page is opened, so a pull that lands while both are
 * closed is lost if the process restarts first. The store dedupes, so this is
 * a no-op whenever there is nothing new.
 *
 * Called once from `app.ts`. Idempotent.
 */
const BACKGROUND_SYNC_INTERVAL_MS = 60 * 1000;
let backgroundSyncTimer: ReturnType<typeof setInterval> | null = null;

export function startLiveHealthSync(): void {
  if (backgroundSyncTimer) return;
  backgroundSyncTimer = setInterval(() => {
    try {
      syncLiveRecords();
    } catch (error) {
      console.warn("health live: background sync failed", error);
    }
  }, BACKGROUND_SYNC_INTERVAL_MS);
}

/**
 * Pull the ring on a wall-clock-aligned cadence: :01 and :31, every hour.
 *
 * Chris, 2026-09-12: *"I think we should be polling the ring on the 30 minute
 * cycle (that was my intent, not a floor honestly)."* The 30-minute value in
 * `RING_HEALTH_MIN_PULL_INTERVAL_MS` was always meant as a collection rhythm
 * and got built as a throttle, so a connected, stable ring pulled never —
 * nothing in the system drives a pull on a timer at all.
 *
 * Two reasons this is aligned to the wall clock rather than a plain interval:
 *
 * 1. **The ring's own step buckets close on 10-minute boundaries.** Pulling on
 *    the boundary collects a just-closed bucket instead of a half-formed one.
 * 2. **An elapsed timer drifts.** A pull at :07 sets the next at :37, then :07,
 *    wandering away from the boundary it is supposed to track. Re-arming
 *    against the clock each time cannot drift.
 *
 * The **one-minute offset is deliberate**: firing exactly at :00 risks catching
 * the ring before it has finalised that bucket.
 *
 * This only *requests* a pull. The communicator still applies its own anti-spam
 * floor, so an extra call here can never hammer the ring.
 */
const ALIGNED_PULL_MINUTES = [1, 31];
let alignedPullTimer: ReturnType<typeof setTimeout> | null = null;

function msUntilNextAlignedPull(now: Date): number {
  const minutes = now.getMinutes();
  const withinHour = ALIGNED_PULL_MINUTES.filter((m) => m > minutes);
  // Next slot this hour, or the first slot of the next hour.
  const target = withinHour.length ? withinHour[0] : ALIGNED_PULL_MINUTES[0] + 60;
  const msIntoMinute = now.getSeconds() * 1000 + now.getMilliseconds();
  return (target - minutes) * 60 * 1000 - msIntoMinute;
}

export function startAlignedRingPull(): void {
  if (alignedPullTimer) return;
  const arm = () => {
    const delay = msUntilNextAlignedPull(new Date());
    alignedPullTimer = setTimeout(() => {
      alignedPullTimer = null;
      try {
        requestFreshPull();
      } catch (error) {
        console.warn("health live: aligned ring pull failed", error);
      }
      arm();                        // re-arm against the clock, never the elapsed time
    }, delay);
  };
  arm();
}

/** Exported for tests — the scheduling arithmetic, with no timer attached. */
export const __alignedPullInternals = { msUntilNextAlignedPull, ALIGNED_PULL_MINUTES };
