// The 2026-09-10 design revisions, pinned where getting them wrong would be
// silent.
//
// These are not tests of "does it draw" - a chart's appearance is checked by
// rendering it (tools/health-preview.cjs writes a PNG of every surface without
// an emulator). What is worth a test here is the handful of places where the
// revision put a SPECIFIC rule in the code that a later reader would plausibly
// undo:
//
//   1. The two sleep stage orders, which differ ON PURPOSE and therefore look
//      exactly like a typo to anyone who meets one without the other.
//   2. The nightly sleep series, which the diverging chart plots - a gap has to
//      stay at its own position or every later night shifts a column.
//   3. The stat rows, where "Buckets" was removed because it was an
//      implementation detail on screen.
//
// Everything runs on generated fixtures. No real health data is read.

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildFixtures } = require("../.test-build/app/health/health-fixtures.js");
const {
  dailySummary,
  sleepNights,
  sleepSummary,
  stageSeconds,
} = require("../.test-build/app/health/health-derive.js");
const {
  SLEEP_LANE_ORDER,
  SLEEP_STACK_ORDER,
  rangeAverageText,
} = require("../.test-build/app/health/health-chart.js");
const { GLANCE_PAGES } = require("../.test-build/app/health/health-glance.js");
const { startOfLocalDay, DAY_MS, SAMPLE_METRICS } = require("../.test-build/app/health/health-types.js");

test("the two sleep stage orders are stated in opposite directions but agree on screen", () => {
  // Week/month/quarter: stacked upward from zero, deep at the bottom.
  assert.deepEqual([...SLEEP_STACK_ORDER], ["deep", "rem", "light"]);
  // One night: lanes listed downward, awake at the top.
  assert.deepEqual([...SLEEP_LANE_ORDER], ["wake", "light", "rem", "deep"]);

  // The point worth pinning. The two orders were given in opposite directions
  // (one bottom-to-top, one top-to-bottom) and therefore READ as contradictory,
  // which is why the brief called the difference out as deliberate. Resolve
  // both to the same direction and the three sleep stages land in the SAME
  // vertical order: light highest, deep lowest. The only real difference is
  // where awake goes - a lane above the others, or a bar below the zero line.
  const stackTopToBottom = [...SLEEP_STACK_ORDER].reverse();
  const lanesTopToBottomWithoutWake = SLEEP_LANE_ORDER.filter((stage) => stage !== "wake");
  assert.deepEqual(
    stackTopToBottom,
    [...lanesTopToBottomWithoutWake],
    "deep sits at the bottom in both views - do not 'fix' one to disagree with the other",
  );

  // Awake is in the lanes and NOT in the upward stack - it diverges downward.
  assert.ok(!SLEEP_STACK_ORDER.includes("wake"));
  assert.ok(SLEEP_LANE_ORDER.includes("wake"));
});

test("the nightly sleep series keeps gaps in position", () => {
  const now = Date.now();
  const today = startOfLocalDay(now);
  const startMs = today - 6 * DAY_MS;
  const { sleep } = buildFixtures({ days: 7, nowMs: now });

  const all = sleepNights(sleep, startMs, today + DAY_MS);
  assert.equal(all.length, 7, "one entry per day in the window, filled or not");

  // Drop the middle night and check the later ones do not slide left.
  const middleDay = all[3].startMs;
  const thinned = sleep.filter((session) => session.dayStartMs !== middleDay);
  const withGap = sleepNights(thinned, startMs, today + DAY_MS);
  assert.equal(withGap.length, 7);
  assert.equal(withGap[3].hasData, false, "the removed night is a gap, not a shift");
  assert.equal(withGap[3].startMs, middleDay);
  assert.deepEqual(
    withGap.map((night) => night.startMs),
    all.map((night) => night.startMs),
    "every night keeps its own day on the axis",
  );
});

test("two sessions on one day are summed, not deduped to the longest", () => {
  const today = startOfLocalDay(Date.now());
  const night = (totalSec, wakeSec) => ({
    dayStartMs: today,
    startMs: today,
    endMs: today,
    totalSec,
    wakeSec,
    remSec: totalSec * 0.2,
    lightSec: totalSec * 0.6,
    deepSec: totalSec * 0.2,
    segments: [],
    timeResolved: true,
  });
  const nights = sleepNights([night(3600, 300), night(1800, 60)], today, today + DAY_MS);
  assert.equal(nights.length, 1);
  assert.equal(nights[0].wakeSec, 360, "a nap's wake time counts too");
  assert.ok(
    Math.abs(nights[0].lightSec - (3600 + 1800) * 0.6) < 1e-6,
    "stage totals add across both sessions",
  );
});

test("a stage's lane duration comes from the named totals", () => {
  const now = Date.now();
  const { sleep } = buildFixtures({ days: 2, nowMs: now });
  const summary = sleepSummary(sleep[0]);
  // The four lanes must account for the whole time in bed, which is exactly
  // the property that does NOT depend on the raw stage-id mapping.
  const summed = SLEEP_LANE_ORDER.reduce(
    (total, stage) => total + stageSeconds(stage, summary),
    0,
  );
  assert.ok(
    Math.abs(summed - (summary.totalSec + summary.wakeSec)) < 1,
    `lanes should sum to time in bed, got ${summed}`,
  );
  assert.equal(stageSeconds("wake", summary), summary.wakeSec);
});

test("the glance line reads as a range and an average", () => {
  assert.equal(
    rangeAverageText({ min: 60, max: 98, avg: 72.6, hasData: true }, "bpm"),
    "60-98 bpm, avg 73",
  );
  assert.equal(
    rangeAverageText({ min: 0, max: 0, avg: 0, hasData: false }, "bpm"),
    "--",
    "no data shows a dash, never a zero",
  );
  // ASCII hyphen only: Terminus has no en dash and would render the default
  // char, putting a "?" in the middle of the number.
  const text = rangeAverageText({ min: 40, max: 62, avg: 51, hasData: true }, "ms");
  for (const char of text) {
    assert.ok(char.codePointAt(0) < 128, `"${char}" is outside ASCII`);
  }
});

test("HRV reached the daily summary", () => {
  const now = Date.now();
  const today = startOfLocalDay(now);
  const { samples, sleep } = buildFixtures({ days: 2, nowMs: now });
  const summary = dailySummary(samples, sleep, today);
  assert.ok(summary.hrv, "HRV is on the glance now - Chris revised the spec");
  assert.ok(summary.hrv.hasData);
  assert.ok(summary.hrv.max >= summary.hrv.min);
});

test("the glasses cursor walks the summary, every parameter, then sleep", () => {
  assert.equal(GLANCE_PAGES[0].kind, "overview", "the glance is where it opens");
  assert.equal(GLANCE_PAGES[GLANCE_PAGES.length - 1].kind, "sleep");
  const walked = GLANCE_PAGES.filter((page) => page.kind === "metric").map((page) => page.metric);
  assert.deepEqual(
    [...walked].sort(),
    [...SAMPLE_METRICS].sort(),
    "every measured parameter is reachable by scrolling",
  );
});
