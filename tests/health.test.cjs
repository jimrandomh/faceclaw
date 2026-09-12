// The health feature's logic, pinned where getting it wrong would be silent.
//
// The three things worth a test here are not the arithmetic - they are the
// places where a bug would quietly produce a plausible wrong answer:
//
//   1. The STORE's durability contract. A health record may be the only copy
//      that will ever exist (the ring appears to discard backlog it thinks it
//      delivered), so "an append never rewrites a file that already holds
//      records" and "a re-sync of the same hour corrects rather than
//      duplicates" are the properties the whole feature rests on.
//   2. The INGEST rules that decline to guess - an unanchored hourly page is
//      dropped, and step buckets do not get invented timestamps.
//   3. SLEEP, where the percentages must come from the named totals (which
//      need no stage-id mapping) while only the hypnogram depends on the ids.
//
// Everything runs on generated fixtures. No real health data is read.

const test = require("node:test");
const assert = require("node:assert/strict");

const { HealthStore } = require("../.test-build/app/health/health-store.js");
const { buildFixtures } = require("../.test-build/app/health/health-fixtures.js");
const {
  dailySummary,
  sleepSummary,
  hypnogram,
  rollupSeries,
  bandIsMeaningful,
  formatDuration,
} = require("../.test-build/app/health/health-derive.js");
const { convertRecords, sleepIdentityHolds } = require("../.test-build/app/health/health-ingest.js");
const {
  STAGE_NAME_BY_ID,
  STAGE_MAPPING_CONFIRMED,
  stageNameForId,
} = require("../.test-build/app/health/sleep-stages.js");
const {
  startOfLocalDay,
  DAY_MS,
  HOUR_MS,
  TEN_MINUTES_MS,
} = require("../.test-build/app/health/health-types.js");

/** An in-memory backend that also records how each file was touched. */
function memoryBackend() {
  const files = new Map();
  const ops = [];
  return {
    ops,
    files,
    exists: (name) => files.has(name),
    read: (name) => files.get(name) ?? null,
    append(name, text) {
      ops.push({ op: "append", name });
      files.set(name, (files.get(name) ?? "") + text);
    },
    write(name, text) {
      ops.push({ op: "write", name });
      files.set(name, text);
    },
    list: () => [...files.keys()],
  };
}

const HOUR = 3600000;

function sample(metric, startMs, min, max, avg, total) {
  return { metric, startMs, spanMs: HOUR, min, max, avg, total: total ?? avg };
}

// ---------------------------------------------------------------------------
// Storage

test("a stored sample survives a fresh store over the same files", () => {
  const backend = memoryBackend();
  const first = new HealthStore(backend);
  const start = startOfLocalDay(Date.now());
  first.ingestSamples([sample("heartRate", start, 55, 90, 70)]);

  const second = new HealthStore(backend);
  const held = second.samplesInRange(start, start + DAY_MS);
  assert.equal(held.length, 1);
  assert.equal(held[0].avg, 70);
});

test("a sample file is only ever appended to, never rewritten", () => {
  const backend = memoryBackend();
  const store = new HealthStore(backend);
  const start = startOfLocalDay(Date.now());
  for (let hour = 0; hour < 6; hour += 1) {
    store.ingestSamples([sample("heartRate", start + hour * HOUR, 50 + hour, 90, 70 + hour)]);
  }
  const sampleWrites = backend.ops.filter(
    (entry) => entry.op === "write" && entry.name.startsWith("samples-"),
  );
  // The rollup cache is rewritten freely - it is derived. The shards are not.
  assert.equal(sampleWrites.length, 0);
  assert.ok(backend.ops.some((entry) => entry.op === "append"));
});

test("re-storing an unchanged bucket writes nothing; a changed one corrects it", () => {
  const backend = memoryBackend();
  const store = new HealthStore(backend);
  const start = startOfLocalDay(Date.now());

  assert.equal(store.ingestSamples([sample("heartRate", start, 55, 90, 70)]), 1);
  // The live poller re-reads the same capped list every 30 minutes; a no-op
  // here is what stops that appending a duplicate line forever.
  assert.equal(store.ingestSamples([sample("heartRate", start, 55, 90, 70)]), 0);
  // The current hour genuinely changes as it fills up. Later line wins.
  assert.equal(store.ingestSamples([sample("heartRate", start, 55, 104, 74)]), 1);

  const reloaded = new HealthStore(backend);
  const held = reloaded.samplesInRange(start, start + DAY_MS);
  assert.equal(held.length, 1);
  assert.equal(held[0].max, 104);
});

test("a corrupt rollup cache is rebuilt from the shards rather than trusted", () => {
  const backend = memoryBackend();
  const store = new HealthStore(backend);
  const start = startOfLocalDay(Date.now());
  store.ingestSamples([sample("heartRate", start, 55, 90, 70), sample("heartRate", start + HOUR, 60, 100, 80)]);

  backend.files.set("rollups.json", "{ not json");
  const recovered = new HealthStore(backend);
  const rollups = recovered.dailyRollups("heartRate", start, start + DAY_MS);
  const day = rollups.get(start);
  assert.ok(day, "the day should be recovered from the raw shards");
  assert.equal(day.min, 55);
  assert.equal(day.max, 100);
  assert.equal(day.count, 2);
});

test("a single unreadable line does not cost the rest of the file", () => {
  const backend = memoryBackend();
  const store = new HealthStore(backend);
  const start = startOfLocalDay(Date.now());
  store.ingestSamples([sample("heartRate", start, 55, 90, 70)]);
  const name = [...backend.files.keys()].find((key) => key.startsWith("samples-"));
  backend.files.set(name, `${backend.files.get(name)}{ truncated\n`);
  store.ingestSamples([sample("heartRate", start + HOUR, 60, 100, 80)]);

  const reloaded = new HealthStore(backend);
  assert.equal(reloaded.samplesInRange(start, start + DAY_MS).length, 2);
});

// ---------------------------------------------------------------------------
// Ingest: the rules that decline to guess

test("an unanchored hourly page is dropped, not dated", () => {
  const result = convertRecords([
    {
      kind: "hourly",
      metric: "heartRate",
      anchorMs: null,
      groups: [{ hourIndex: 0, avg: 70, max: 90, min: 55 }],
    },
  ]);
  assert.equal(result.samples.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].why, /anchor/);
});

test("an anchored hourly page dates each group from the anchor", () => {
  const anchor = startOfLocalDay(Date.now());
  const result = convertRecords([
    {
      kind: "hourly",
      metric: "hrv",
      anchorMs: anchor,
      groups: [
        { hourIndex: 0, avg: 40, max: 40, min: 40 },
        { hourIndex: 5, avg: 52, max: 55, min: 50 },
      ],
    },
  ]);
  assert.equal(result.samples.length, 2);
  assert.equal(result.samples[0].startMs, anchor);
  assert.equal(result.samples[1].startMs, anchor + 5 * HOUR_MS);
});

// The index is cracked (2026-09-12): bucket i starts at anchor + i * 10 minutes.
// This test previously asserted the opposite - one day-span total, buckets
// deliberately discarded - which was the honest call while the index was only
// trusted as an identity. It is now the placement contract.
test("steps place each bucket at anchor + index * ten minutes", () => {
  const anchor = startOfLocalDay(Date.now());
  const result = convertRecords([
    {
      kind: "steps",
      anchorMs: anchor,
      buckets: [
        { index: 0, steps: 100, activeCalories: 4, totalCalories: 15 },
        { index: 130, steps: 260, activeCalories: 9, totalCalories: 21 },
      ],
    },
  ]);
  const steps = result.samples.filter((entry) => entry.metric === "steps");
  assert.equal(steps.length, 2, "one sample per bucket, not one day total");
  assert.equal(steps[0].startMs, anchor);
  assert.equal(steps[0].total, 100);
  assert.equal(steps[0].spanMs, TEN_MINUTES_MS);
  assert.equal(steps[1].startMs, anchor + 130 * TEN_MINUTES_MS);
  assert.equal(steps[1].total, 260);

  // The day total is now `sum` and ONLY `sum` - `max`/`avg` are per-bucket.
  // Every reader was checked against this on 2026-09-12.
  assert.equal(
    steps.reduce((acc, entry) => acc + entry.total, 0),
    360,
  );

  const calories = result.samples.filter((entry) => entry.metric === "calories");
  assert.equal(calories.length, 2);
  assert.equal(calories[1].startMs, anchor + 130 * TEN_MINUTES_MS);
  assert.equal(calories[1].total, 21);

  // Nothing is declined any more - the buckets are placed, not discarded.
  assert.equal(result.skipped.length, 0);
});

test("a sleep session is stored with its time marked unresolved", () => {
  const result = convertRecords([
    {
      kind: "sleep",
      startTs: 90000,
      endTs: 90000 + 21600,
      totalSec: 20400,
      wakeSec: 1200,
      remSec: 3600,
      lightSec: 12000,
      deepSec: 4800,
      segments: [{ stageId: 2, halfMinutes: 720 }],
      receivedAtMs: Date.now(),
    },
  ]);
  assert.equal(result.sleep.length, 1);
  assert.equal(result.sleep[0].timeResolved, false);
  assert.equal(result.sleep[0].dayStartMs, startOfLocalDay(Date.now()));
});

// The first real sleep record off the hardware, 2026-09-12, verbatim from
// `files/health/sleep.jsonl` under com.faceclaw.app. It is here as a FROZEN
// known-good: the -8h correction was derived from Chris confirming the window
// two independent ways, and a future change that quietly makes it -4h again
// (or 0h, which is what shipped first) should fail a test rather than wait to
// be noticed in a chart.
const REAL_SLEEP_RECORD = {
  kind: "sleep",
  startTs: 1789222861,
  endTs: 1789233931,
  totalSec: 10440,
  wakeSec: 630,
  remSec: 1620,
  lightSec: 5880,
  deepSec: 2940,
  segments: [
    { stageId: 0, halfMinutes: 21 },
    { stageId: 2, halfMinutes: 42 },
    { stageId: 3, halfMinutes: 36 },
    { stageId: 2, halfMinutes: 40 },
    { stageId: 1, halfMinutes: 36 },
    { stageId: 2, halfMinutes: 42 },
    { stageId: 3, halfMinutes: 62 },
    { stageId: 2, halfMinutes: 46 },
    { stageId: 1, halfMinutes: 18 },
    { stageId: 2, halfMinutes: 26 },
  ],
  receivedAtMs: 1789234000000,
};

test("a clock correction promotes a sleep session to a real placement", () => {
  const rawStartMs = REAL_SLEEP_RECORD.startTs * 1000;
  // Twice the hourly ring-clock offset, computed the way health-live.ts
  // computes it - so this says what the RULE is rather than restating a
  // constant that would rot at the November DST change.
  const correction = 2 * new Date(rawStartMs).getTimezoneOffset() * 60 * 1000;

  const result = convertRecords([{ ...REAL_SLEEP_RECORD, clockCorrectionMs: correction }]);
  assert.equal(result.sleep.length, 1);
  const night = result.sleep[0];

  assert.equal(night.timeResolved, true, "a corrected session is placed, not unresolved");
  assert.equal(night.startMs, rawStartMs - correction);
  assert.equal(night.endMs, REAL_SLEEP_RECORD.endTs * 1000 - correction);
  // The wake-up day, not the day it happened to be received on.
  assert.equal(night.dayStartMs, startOfLocalDay(night.endMs));
  // The correction must move where the night sits, never how long it was.
  assert.equal(night.endMs - night.startMs, 11070 * 1000);
  assert.equal(night.totalSec, 10440);
});

test("the real 2026-09-12 record decodes to the window Chris confirmed", (t) => {
  // EDT only: the known-good is a wall-clock reading and the assertion is
  // meaningless in another zone. Skipped rather than weakened elsewhere.
  if (new Date(REAL_SLEEP_RECORD.startTs * 1000).getTimezoneOffset() !== 240) {
    t.skip("not EDT");
    return;
  }
  const result = convertRecords([{ ...REAL_SLEEP_RECORD, clockCorrectionMs: 8 * 3600 * 1000 }]);
  const night = result.sleep[0];
  const local = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "America/New_York" });
  assert.equal(local(night.startMs), "2026-09-12 02:21:01");
  assert.equal(local(night.endMs), "2026-09-12 05:25:31");
});

// ---------------------------------------------------------------------------
// Sleep

test("stage percentages come from the named totals, not from the stage ids", () => {
  const session = {
    dayStartMs: startOfLocalDay(Date.now()),
    startMs: 0,
    endMs: 0,
    totalSec: 20000,
    wakeSec: 1000,
    remSec: 4000,
    lightSec: 12000,
    deepSec: 4000,
    // Deliberately unmappable ids: the percentages must not care.
    segments: [{ stageId: 9, halfMinutes: 700 }],
    timeResolved: true,
  };
  const summary = sleepSummary(session);
  assert.equal(Math.round(summary.remPercent), 20);
  assert.equal(Math.round(summary.lightPercent), 60);
  assert.equal(Math.round(summary.deepPercent), 20);
  // total / (total + wake) = 20000 / 21000
  assert.equal(Math.round(summary.efficiencyPercent), 95);
  // ...while the hypnogram, which does depend on the ids, says so.
  assert.equal(hypnogram(session)[0].stage, null);
});

test("the stage-id mapping is the one named place, and it is the derived one", () => {
  assert.equal(stageNameForId(0), "wake");
  assert.equal(stageNameForId(1), "rem");
  assert.equal(stageNameForId(2), "light");
  assert.equal(stageNameForId(3), "deep");
  assert.equal(stageNameForId(4), null);
  assert.equal(Object.keys(STAGE_NAME_BY_ID).length, 4);
  // Pinned deliberately: flipping this is the confirmation step, and it should
  // be a decision someone makes, not something that drifts.
  assert.equal(STAGE_MAPPING_CONFIRMED, false);
});

test("no sleep-quality composite is exposed", () => {
  const summary = sleepSummary({
    dayStartMs: 0, startMs: 0, endMs: 0,
    totalSec: 20000, wakeSec: 1000, remSec: 4000, lightSec: 12000, deepSec: 4000,
    segments: [], timeResolved: true,
  });
  const invented = Object.keys(summary).filter((key) => /quality|score/i.test(key));
  assert.deepEqual(invented, []);
});

// ---------------------------------------------------------------------------
// Series and fixtures

test("a range with no data comes back as gaps at the right positions", () => {
  const start = startOfLocalDay(Date.now());
  const points = rollupSeries([sample("heartRate", start + 3 * HOUR, 55, 90, 70)], {
    metric: "heartRate",
    granularity: "hour",
    startMs: start,
    endMs: start + DAY_MS,
  });
  assert.equal(points.length, 24);
  assert.equal(points[0].count, 0);
  assert.equal(points[3].count, 1);
  assert.equal(points[3].avg, 70);
});

test("the band is drawn for heart rate and dropped for a collapsed metric", () => {
  const start = startOfLocalDay(Date.now());
  const spread = [];
  const flat = [];
  for (let hour = 0; hour < 12; hour += 1) {
    spread.push({ startMs: start + hour * HOUR, spanMs: HOUR, min: 60, max: 92, avg: 74, sum: 74, count: 1 });
    flat.push({ startMs: start + hour * HOUR, spanMs: HOUR, min: 97, max: 97, avg: 97, sum: 97, count: 1 });
  }
  assert.equal(bandIsMeaningful(spread), true);
  assert.equal(bandIsMeaningful(flat), false);
});

test("the fixtures reproduce the shapes the real export has", () => {
  const now = Date.now();
  const { samples, sleep } = buildFixtures({ days: 7, nowMs: now });

  const hourly = samples.filter((entry) => entry.metric === "heartRate");
  assert.ok(hourly.every((entry) => entry.spanMs === HOUR_MS), "heart rate is hourly");
  const stepBuckets = samples.filter((entry) => entry.metric === "steps");
  assert.ok(stepBuckets.every((entry) => entry.spanMs === 600000), "steps are ten-minute");

  // Heart rate has a real spread; SpO2 mostly does not. Both were measured off
  // the export before the generator was written.
  const hrSpread = hourly.filter((entry) => entry.max > entry.min).length / hourly.length;
  const spo2 = samples.filter((entry) => entry.metric === "spo2");
  const spo2Spread = spo2.filter((entry) => entry.max > entry.min).length / spo2.length;
  assert.ok(hrSpread > 0.9, `heart rate should nearly always have spread, got ${hrSpread}`);
  assert.ok(spo2Spread < 0.15, `SpO2 should rarely have spread, got ${spo2Spread}`);

  // Every generated night satisfies the same identity real records satisfy.
  for (const night of sleep) {
    assert.ok(
      sleepIdentityHolds(night),
      "segment run must account for exactly the time in bed",
    );
  }
});

test("the daily summary picks last night and today's own buckets", () => {
  const now = Date.now();
  const today = startOfLocalDay(now);
  const { samples, sleep } = buildFixtures({ days: 3, nowMs: now });
  const summary = dailySummary(samples, sleep, today);
  assert.equal(summary.dayStartMs, today);
  assert.ok(summary.heartRate.hasData);
  assert.ok(summary.sleep, "there should be a night attributed to today");
  assert.ok(summary.steps >= 0);
});

test("durations format the way the glance prints them", () => {
  assert.equal(formatDuration(0), "--");
  assert.equal(formatDuration(6 * 3600 + 12 * 60), "6h 12m");
  assert.equal(formatDuration(45 * 60), "45m");
});
