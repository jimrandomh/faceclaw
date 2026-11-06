const test = require("node:test");
const assert = require("node:assert/strict");

const {
  GLANCE_HIDDEN,
  GLANCE_TIMEOUT_MS,
  GLANCE_TILT_MAX_MS,
  glanceEventForGesture,
  glanceTiltMaxMs,
  reduceGlance,
} = require("../.test-build/app/g2/glance-state.js");

const T0 = 1_000_000;

test("a press shows the board and arms the auto-hide timer", () => {
  const shown = reduceGlance(GLANCE_HIDDEN, { type: "press" }, T0);
  assert.deepEqual(shown, { visible: true, holding: false, tilted: false, tiltMaxMs: 0, hideAtMs: T0 + GLANCE_TIMEOUT_MS });
  // A timer firing early is ignored; on time it hides.
  assert.equal(reduceGlance(shown, { type: "timeout" }, T0 + GLANCE_TIMEOUT_MS - 1), shown);
  assert.deepEqual(reduceGlance(shown, { type: "timeout" }, T0 + GLANCE_TIMEOUT_MS), GLANCE_HIDDEN);
});

test("a further press renews the timer from the new press", () => {
  const shown = reduceGlance(GLANCE_HIDDEN, { type: "press" }, T0);
  const renewed = reduceGlance(shown, { type: "press" }, T0 + 2000);
  assert.equal(renewed.hideAtMs, T0 + 2000 + GLANCE_TIMEOUT_MS);
  assert.equal(reduceGlance(renewed, { type: "timeout" }, T0 + GLANCE_TIMEOUT_MS), renewed);
});

test("a hold shows the board without a timer and the release hides it", () => {
  const held = reduceGlance(GLANCE_HIDDEN, { type: "hold" }, T0);
  assert.deepEqual(held, { visible: true, holding: true, tilted: false, tiltMaxMs: 0, hideAtMs: null });
  assert.equal(reduceGlance(held, { type: "timeout" }, T0 + 60_000), held);
  // A tap mid-hold neither hides nor starts a timer.
  assert.equal(reduceGlance(held, { type: "press" }, T0 + 500), held);
  assert.deepEqual(reduceGlance(held, { type: "release" }, T0 + 1000), GLANCE_HIDDEN);
});

test("a release that was not holding the board is ignored", () => {
  assert.equal(reduceGlance(GLANCE_HIDDEN, { type: "release" }, T0), GLANCE_HIDDEN);
  const shown = reduceGlance(GLANCE_HIDDEN, { type: "press" }, T0);
  assert.equal(reduceGlance(shown, { type: "release" }, T0 + 100), shown);
});

test("dismiss hides from any state", () => {
  const held = reduceGlance(GLANCE_HIDDEN, { type: "hold" }, T0);
  assert.deepEqual(reduceGlance(held, { type: "dismiss" }, T0), GLANCE_HIDDEN);
  const shown = reduceGlance(GLANCE_HIDDEN, { type: "press" }, T0);
  assert.deepEqual(reduceGlance(shown, { type: "dismiss" }, T0), GLANCE_HIDDEN);
});

test("gesture mapping: taps press, head-tilt tilts, both long-press gestures hold, double-tap dismisses only a visible board", () => {
  assert.deepEqual(glanceEventForGesture("click", false), { type: "press" });
  assert.deepEqual(glanceEventForGesture("head-tilt", false), { type: "tilt" });
  assert.deepEqual(glanceEventForGesture("head-down", true), { type: "head-down" });
  assert.equal(glanceEventForGesture("head-down", false), null);
  assert.deepEqual(glanceEventForGesture("long-press", false), { type: "hold" });
  assert.deepEqual(glanceEventForGesture("short-then-long-press", false), { type: "hold" });
  assert.deepEqual(glanceEventForGesture("short-then-long-press", true), { type: "hold" });
  assert.deepEqual(glanceEventForGesture("long-press-release", true), { type: "release" });
  assert.equal(glanceEventForGesture("double-click", false), null);
  assert.deepEqual(glanceEventForGesture("double-click", true), { type: "dismiss" });
  assert.equal(glanceEventForGesture("scroll-up", true), null);
});

test("the press timeout is the host's when supplied", () => {
  const shown = reduceGlance(GLANCE_HIDDEN, { type: "press" }, T0, 10_000);
  assert.equal(shown.hideAtMs, T0 + 10_000);
  assert.equal(reduceGlance(shown, { type: "timeout" }, T0 + GLANCE_TIMEOUT_MS), shown);
  assert.deepEqual(reduceGlance(shown, { type: "timeout" }, T0 + 10_000), GLANCE_HIDDEN);
});

test("a head-tilt shows the board until the head comes back down", () => {
  const up = reduceGlance(GLANCE_HIDDEN, { type: "tilt" }, T0);
  assert.deepEqual(up, { visible: true, holding: false, tilted: true, tiltMaxMs: GLANCE_TILT_MAX_MS, hideAtMs: T0 + GLANCE_TILT_MAX_MS });
  // The tap duration no longer applies, and taps change nothing.
  assert.equal(reduceGlance(up, { type: "timeout" }, T0 + GLANCE_TIMEOUT_MS), up);
  assert.equal(reduceGlance(up, { type: "press" }, T0 + 500), up);
  assert.deepEqual(reduceGlance(up, { type: "head-down" }, T0 + 9000), GLANCE_HIDDEN);
  // The safety cap still hides it if the head-down never arrives.
  assert.deepEqual(reduceGlance(up, { type: "timeout" }, T0 + GLANCE_TILT_MAX_MS), GLANCE_HIDDEN);
});

test("head-down leaves a tap's or a hold's showing alone", () => {
  const shown = reduceGlance(GLANCE_HIDDEN, { type: "press" }, T0);
  assert.equal(reduceGlance(shown, { type: "head-down" }, T0 + 100), shown);
  const held = reduceGlance(GLANCE_HIDDEN, { type: "hold" }, T0);
  assert.equal(reduceGlance(held, { type: "head-down" }, T0 + 100), held);
});

test("a hold and a head-tilt together: the board stays until both end", () => {
  const both = reduceGlance(reduceGlance(GLANCE_HIDDEN, { type: "tilt" }, T0), { type: "hold" }, T0 + 100);
  assert.deepEqual(both, { visible: true, holding: true, tilted: true, tiltMaxMs: GLANCE_TILT_MAX_MS, hideAtMs: null });
  const released = reduceGlance(both, { type: "release" }, T0 + 200);
  assert.deepEqual(released, { visible: true, holding: false, tilted: true, tiltMaxMs: GLANCE_TILT_MAX_MS, hideAtMs: T0 + 200 + GLANCE_TILT_MAX_MS });
  const downWhileHeld = reduceGlance(both, { type: "head-down" }, T0 + 200);
  assert.deepEqual(downWhileHeld, { visible: true, holding: true, tilted: false, tiltMaxMs: 0, hideAtMs: null });
  assert.deepEqual(reduceGlance(downWhileHeld, { type: "release" }, T0 + 300), GLANCE_HIDDEN);
});

test("a tilt with a shorter cap keeps it, also across a hold", () => {
  const up = reduceGlance(GLANCE_HIDDEN, { type: "tilt", maxMs: 5000 }, T0);
  assert.equal(up.hideAtMs, T0 + 5000);
  assert.deepEqual(reduceGlance(up, { type: "timeout" }, T0 + 5000), GLANCE_HIDDEN);
  const held = reduceGlance(up, { type: "hold" }, T0 + 100);
  assert.equal(reduceGlance(held, { type: "release" }, T0 + 1000).hideAtMs, T0 + 1000 + 5000);
});

test("the tilt cap is the Head tilt timeout, or the tap duration if shorter where the head-down is unlikely", () => {
  const tapTimeoutMs = 5000;
  const cap = (capMs, resumedSession, triggerDegrees) => glanceTiltMaxMs({ capMs, resumedSession, triggerDegrees, tapTimeoutMs });
  assert.equal(cap(60_000, false, 30), 60_000);
  assert.equal(cap(15_000, false, null), 15_000);
  assert.equal(cap(null, false, 30), null);
  assert.equal(cap(60_000, true, 30), tapTimeoutMs);
  assert.equal(cap(60_000, false, 20), tapTimeoutMs);
  assert.equal(cap(null, false, 20), tapTimeoutMs);
  assert.equal(cap(3000, true, 30), 3000);
  assert.equal(cap(60_000, false, 25), 60_000);
});

test("a tilt with no timeout stays until the head-down, also across a hold", () => {
  const up = reduceGlance(GLANCE_HIDDEN, { type: "tilt", maxMs: null }, T0);
  assert.equal(up.hideAtMs, null);
  assert.equal(reduceGlance(up, { type: "timeout" }, T0 + 3_600_000), up);
  const held = reduceGlance(up, { type: "hold" }, T0 + 100);
  assert.equal(reduceGlance(held, { type: "release" }, T0 + 1000).hideAtMs, null);
  assert.deepEqual(reduceGlance(up, { type: "head-down" }, T0 + 9000), GLANCE_HIDDEN);
});
