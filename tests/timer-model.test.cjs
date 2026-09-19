// Pins the Timers app's clock arithmetic: the duration dial's ladder, the
// countdown / stopwatch / span formatting the stage shows, alarm scheduling
// across days and repeat masks, and the argument parsing the assistant
// tools rely on.
const test = require("node:test");
const assert = require("node:assert/strict");

const model = require("../.test-build/app/apps/timer/timer-model.js");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

test("the duration ladder is strictly increasing and spans 10s to 24h", () => {
  const ladder = model.DURATION_LADDER_MS;
  assert.equal(ladder[0], 10_000);
  assert.equal(ladder[ladder.length - 1], 24 * HOUR);
  for (let index = 1; index < ladder.length; index++) {
    assert.ok(ladder[index] > ladder[index - 1], `rung ${index} not increasing`);
  }
  assert.ok(ladder.includes(10 * MINUTE));
  assert.ok(ladder.includes(25 * MINUTE));
  assert.ok(ladder.includes(90 * MINUTE));
});

test("nearestLadderIndex snaps to the closest rung", () => {
  assert.equal(model.DURATION_LADDER_MS[model.nearestLadderIndex(10 * MINUTE)], 10 * MINUTE);
  assert.equal(model.DURATION_LADDER_MS[model.nearestLadderIndex(11 * MINUTE + 20_000)], 11 * MINUTE);
  assert.equal(model.nearestLadderIndex(0), 0);
  assert.equal(model.nearestLadderIndex(1000 * HOUR), model.DURATION_LADDER_MS.length - 1);
});

test("countdown rounds up so 0:00 means finished; elapsed rounds down", () => {
  assert.equal(model.formatCountdown(59_001), "1:00");
  assert.equal(model.formatCountdown(59_000), "0:59");
  assert.equal(model.formatCountdown(0), "0:00");
  assert.equal(model.formatCountdown(HOUR + 5 * MINUTE + 3000), "1:05:03");
  assert.equal(model.formatElapsed(59_950, false), "0:59");
  assert.equal(model.formatElapsed(59_950, true), "0:59.9");
  assert.equal(model.formatElapsed(HOUR, true), "1:00:00.0");
});

test("durations and spans read naturally", () => {
  assert.equal(model.formatDurationWords(20 * MINUTE), "20 min");
  assert.equal(model.formatDurationWords(90 * MINUTE), "1h 30m");
  assert.equal(model.formatDurationWords(45_000), "45s");
  assert.equal(model.formatDurationWords(2 * MINUTE + 30_000), "2m 30s");
  assert.equal(model.formatSpanWords(9 * HOUR + 12 * MINUTE), "9h 12m");
  assert.equal(model.formatSpanWords(12 * MINUTE), "12m");
  assert.equal(model.formatSpanWords(30 * HOUR), "1d 6h");
});

test("time of day honours the 12/24-hour choice", () => {
  assert.equal(model.formatTimeOfDay(7, 5, false), "7:05");
  assert.equal(model.formatTimeOfDay(19, 30, false), "19:30");
  assert.equal(model.formatTimeOfDay(0, 0, true), "12:00 AM");
  assert.equal(model.formatTimeOfDay(12, 0, true), "12:00 PM");
  assert.equal(model.formatTimeOfDay(19, 30, true), "7:30 PM");
});

function alarm(hour, minute, days, extra = {}) {
  return { id: 1, hour, minute, days, label: "", enabled: true, snoozedUntilMs: null, ringingSinceMs: null, lastFiredAtMs: null, ...extra };
}

/** Local-time constructor: Wednesday 2026-09-02 at hh:mm. */
function wednesday(hour, minute) {
  return new Date(2026, 8, 2, hour, minute, 0, 0).getTime();
}

test("a one-off alarm rings later today, else tomorrow", () => {
  const now = wednesday(8, 0);
  assert.equal(model.alarmNextRingMs(alarm(9, 30, 0), now), wednesday(9, 30));
  assert.equal(model.alarmNextRingMs(alarm(7, 0, 0), now), new Date(2026, 8, 3, 7, 0).getTime());
  // Exactly now counts as passed.
  assert.equal(model.alarmNextRingMs(alarm(8, 0, 0), now), new Date(2026, 8, 3, 8, 0).getTime());
});

test("a repeating alarm skips to its next enabled day", () => {
  const now = wednesday(8, 0);
  // Weekends only: Wednesday -> Saturday.
  assert.equal(model.alarmNextRingMs(alarm(7, 0, model.WEEKEND_MASK), now), new Date(2026, 8, 5, 7, 0).getTime());
  // Weekdays, time already passed today: Thursday.
  assert.equal(model.alarmNextRingMs(alarm(7, 0, model.WEEKDAYS_MASK), now), new Date(2026, 8, 3, 7, 0).getTime());
  // Only Wednesdays, time passed: a week from now.
  assert.equal(model.alarmNextRingMs(alarm(7, 0, model.DAY_BITS[2]), now), new Date(2026, 8, 9, 7, 0).getTime());
});

test("an alarm does not ring twice for the occurrence it last fired for", () => {
  const now = wednesday(7, 0) + 20_000;
  const fired = alarm(7, 0, model.EVERY_DAY_MASK, { lastFiredAtMs: wednesday(7, 0) });
  assert.equal(model.alarmNextRingMs(fired, now - 5 * MINUTE), new Date(2026, 8, 3, 7, 0).getTime());
});

test("snooze and disabled override the schedule", () => {
  const now = wednesday(8, 0);
  assert.equal(model.alarmNextRingMs(alarm(7, 0, 0, { snoozedUntilMs: now + 10 * MINUTE }), now), now + 10 * MINUTE);
  assert.equal(model.alarmNextRingMs(alarm(7, 0, 0, { enabled: false }), now), null);
});

test("repeat masks have readable names", () => {
  assert.equal(model.formatDays(0), "Once");
  assert.equal(model.formatDays(model.WEEKDAYS_MASK), "Weekdays");
  assert.equal(model.formatDays(model.WEEKEND_MASK), "Weekends");
  assert.equal(model.formatDays(model.EVERY_DAY_MASK), "Every day");
  assert.equal(model.formatDays(model.DAY_BITS[0] | model.DAY_BITS[2] | model.DAY_BITS[4]), "Mon Wed Fri");
});

test("timers sort ringing first, then soonest running, then paused", () => {
  const now = 1_000_000;
  const running = { id: 1, label: "", durationMs: 600_000, endsAtMs: now + 300_000, pausedRemainingMs: null, rungAtMs: null, createdAtMs: 1 };
  const sooner = { ...running, id: 2, endsAtMs: now + 60_000 };
  const paused = { ...running, id: 3, endsAtMs: null, pausedRemainingMs: 10_000 };
  const rung = { ...running, id: 4, endsAtMs: null, rungAtMs: now - 5000 };
  assert.deepEqual(model.sortTimers([running, paused, rung, sooner], now).map((timer) => timer.id), [4, 2, 1, 3]);
});

test("tool arguments: times of day", () => {
  assert.deepEqual(model.parseTimeOfDay("7:30"), { hour: 7, minute: 30 });
  assert.deepEqual(model.parseTimeOfDay("7:30 pm"), { hour: 19, minute: 30 });
  assert.deepEqual(model.parseTimeOfDay("12 am"), { hour: 0, minute: 0 });
  assert.deepEqual(model.parseTimeOfDay("12:15PM"), { hour: 12, minute: 15 });
  assert.deepEqual(model.parseTimeOfDay("19:30"), { hour: 19, minute: 30 });
  assert.deepEqual(model.parseTimeOfDay("noon"), { hour: 12, minute: 0 });
  assert.equal(model.parseTimeOfDay("25:00"), null);
  assert.equal(model.parseTimeOfDay("13 pm"), null);
  assert.equal(model.parseTimeOfDay("soon"), null);
});

test("tool arguments: repeat days", () => {
  assert.equal(model.parseRepeatDays(undefined), 0);
  assert.equal(model.parseRepeatDays(["weekdays"]), model.WEEKDAYS_MASK);
  assert.equal(model.parseRepeatDays("every day"), model.EVERY_DAY_MASK);
  assert.equal(model.parseRepeatDays(["mon", "Wednesday", "fri"]), model.DAY_BITS[0] | model.DAY_BITS[2] | model.DAY_BITS[4]);
  assert.equal(model.parseRepeatDays(["someday"]), null);
});

test("persisted state survives a round trip and shrugs off junk", () => {
  const state = model.emptyTimersState();
  state.timers.push(model.createTimer(5 * MINUTE, "tea", 1000));
  state.alarms.push(model.createAlarm(7, 30, model.WEEKDAYS_MASK, "work", 1000));
  state.stopwatch = { accumulatedMs: 1234, runningSinceMs: null, lapsMs: [500, 1000] };
  state.recentDurationsMs = [5 * MINUTE];
  const restored = model.parseTimersState(model.serializeTimersState(state));
  assert.deepEqual(restored, state);
  assert.deepEqual(model.parseTimersState("not json"), model.emptyTimersState());
  assert.deepEqual(model.parseTimersState(JSON.stringify({ timers: [{ id: "x" }], alarms: [null] })), model.emptyTimersState());
});

test("recent durations stay short and deduplicated", () => {
  assert.deepEqual(model.pushRecentDuration([1, 2, 3], 2), [2, 1, 3]);
  assert.deepEqual(model.pushRecentDuration([1, 2, 3], 4), [4, 1, 2]);
});
