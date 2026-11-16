const test = require("node:test");
const assert = require("node:assert/strict");

const { NotificationPopupTimeout } = require("../.test-build/app/ui/shell/notification-popup-timeout.js");

/** A manual clock: schedule() queues timers that advance() fires when due. */
function makeClock() {
  const clock = {
    nowMs: 0,
    timers: [],
    schedule(run, delayMs) {
      const timer = { dueAtMs: clock.nowMs + delayMs, run, cancelled: false };
      clock.timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    advance(ms) {
      const until = clock.nowMs + ms;
      for (;;) {
        const due = clock.timers.filter((timer) => !timer.cancelled && timer.dueAtMs <= until)
          .sort((a, b) => a.dueAtMs - b.dueAtMs)[0];
        if (!due) break;
        clock.nowMs = due.dueAtMs;
        due.cancelled = true;
        due.run();
      }
      clock.nowMs = until;
    },
  };
  return clock;
}

function makeTimeout(timeoutMs) {
  const clock = makeClock();
  let expiries = 0;
  const timeout = new NotificationPopupTimeout(timeoutMs, () => { expiries++; }, clock.schedule);
  return { clock, timeout, expiries: () => expiries };
}

test("an untouched popup expires once its timeout passes", () => {
  const { clock, timeout, expiries } = makeTimeout(15_000);
  timeout.restart();
  clock.advance(14_999);
  assert.equal(expiries(), 0);
  clock.advance(1);
  assert.equal(expiries(), 1);
  assert.equal(timeout.isRunning(), false);
  clock.advance(60_000);
  assert.equal(expiries(), 1);
});

test("each interaction starts the countdown over", () => {
  const { clock, timeout, expiries } = makeTimeout(5_000);
  timeout.restart();
  clock.advance(4_000);
  timeout.restart(); // e.g. scrolling the action menu
  clock.advance(4_000);
  assert.equal(expiries(), 0);
  clock.advance(1_000);
  assert.equal(expiries(), 1);
});

test("a popup that goes away first never expires", () => {
  const { clock, timeout, expiries } = makeTimeout(5_000);
  timeout.restart();
  clock.advance(2_000);
  timeout.stop();
  clock.advance(10_000);
  assert.equal(expiries(), 0);
});

test("until-dismissed (no timeout) never schedules anything", () => {
  const { clock, timeout, expiries } = makeTimeout(null);
  timeout.restart();
  assert.equal(timeout.isRunning(), false);
  assert.equal(clock.timers.length, 0);
  clock.advance(1_000_000);
  assert.equal(expiries(), 0);
});

test("the expiry callback can restart the countdown (something was over the popup)", () => {
  const clock = makeClock();
  let expiries = 0;
  const timeout = new NotificationPopupTimeout(5_000, () => {
    expiries++;
    if (expiries === 1) timeout.restart();
  }, clock.schedule);
  timeout.restart();
  clock.advance(5_000);
  assert.equal(expiries, 1);
  assert.equal(timeout.isRunning(), true);
  clock.advance(5_000);
  assert.equal(expiries, 2);
  assert.equal(timeout.isRunning(), false);
});
