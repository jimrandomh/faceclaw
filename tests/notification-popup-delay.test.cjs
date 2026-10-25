const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FOREGROUND_SERVICE_POPUP_DELAY_MS,
  NOTIFICATION_POPUP_DELAY_MS,
  NotificationPopupDelay,
  notificationPopupDelayMs,
} = require("../.test-build/app/ui/shell/notification-popup-delay.js");

/** A manual clock: schedule() queues timers that advance() fires in due order. */
function makeClock() {
  const clock = {
    nowMs: 0,
    timers: [],
    now: () => clock.nowMs,
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

function makeDelay() {
  const clock = makeClock();
  const ready = [];
  const delay = new NotificationPopupDelay((key) => ready.push(key), clock.schedule, clock.now);
  return { clock, ready, delay };
}

test("a notification pops up once its delay passes", () => {
  const { clock, ready, delay } = makeDelay();
  delay.post("a", 500);
  clock.advance(499);
  assert.deepEqual(ready, []);
  assert.deepEqual(delay.pendingKeys(), ["a"]);
  clock.advance(1);
  assert.deepEqual(ready, ["a"]);
  assert.deepEqual(delay.pendingKeys(), []);
});

test("one withdrawn while waiting never pops up; the replacement still does", () => {
  const { clock, ready, delay } = makeDelay();
  // Messages: a foreground-service placeholder, the message under another key, then the placeholder goes.
  delay.post("working", 5000);
  clock.advance(2000);
  delay.post("message", 500);
  assert.equal(delay.withdraw("working"), true);
  clock.advance(10000);
  assert.deepEqual(ready, ["message"]);
  assert.equal(delay.withdraw("working"), false);
  assert.equal(delay.withdraw("message"), false, "already popped up");
});

test("reposts can bring a popup forward but never push it back", () => {
  const { clock, ready, delay } = makeDelay();
  delay.post("a", 500);
  clock.advance(400);
  delay.post("a", 500);
  clock.advance(100);
  assert.deepEqual(ready, ["a"], "an update does not restart the delay");

  // Rewritten from a foreground-service placeholder into the real notification, same key.
  delay.post("b", 5000);
  clock.advance(1000);
  delay.post("b", 500);
  clock.advance(500);
  assert.deepEqual(ready, ["a", "b"]);
  clock.advance(10000);
  assert.deepEqual(ready, ["a", "b"], "the earlier timer was cancelled");
});

test("foreground-service notifications wait longer, unless urgent", () => {
  assert.equal(notificationPopupDelayMs({ category: "msg" }), NOTIFICATION_POPUP_DELAY_MS);
  assert.equal(notificationPopupDelayMs({ category: "", foregroundService: true }), FOREGROUND_SERVICE_POPUP_DELAY_MS);
  assert.equal(notificationPopupDelayMs({ category: "call", foregroundService: true }), NOTIFICATION_POPUP_DELAY_MS);
  assert.equal(notificationPopupDelayMs({ category: "alarm", foregroundService: true }), NOTIFICATION_POPUP_DELAY_MS);
  assert.ok(FOREGROUND_SERVICE_POPUP_DELAY_MS > NOTIFICATION_POPUP_DELAY_MS);
});
