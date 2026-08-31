// Speaker-dot tracking for the Sonic Radar: dots are world-frame, follow
// their speaker as they wander (smooth for jitter, snap for real moves,
// glide live while talking), and brightness-code active speech vs. silence
// age. These pin the behaviours the radar display depends on.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SPEAKER_DOT_TTL_MS,
  normalizeDeg,
  smoothAngleDeg,
  placeDotForUtterance,
  trackSpeakingDot,
  clearSpeaking,
  pruneDots,
  dotBrightness,
} = require("../.test-build/app/apps/microphones/radar-dots.js");

const alice = { speakerId: 1, name: "Alice", color: "#ff0000" };
const bob = { speakerId: 2, name: "Bob", color: "#00ff00" };

test("normalizeDeg wraps into (-180, 180]", () => {
  assert.equal(normalizeDeg(0), 0);
  assert.equal(normalizeDeg(180), 180);
  assert.equal(normalizeDeg(-180), 180);
  assert.equal(normalizeDeg(190), -170);
  assert.equal(normalizeDeg(-190), 170);
  assert.equal(normalizeDeg(720), 0);
});

test("smoothAngleDeg follows the short way across the seam", () => {
  assert.equal(smoothAngleDeg(null, 400, 0.5), 40);
  // 170 -> -170 is 20 degrees the short way, not 340 the long way.
  const smoothed = smoothAngleDeg(170, -170, 0.5);
  assert.ok(Math.abs(normalizeDeg(smoothed - 180)) < 1e-9);
});

test("an utterance creates a dot for a new speaker", () => {
  const dots = placeDotForUtterance([], alice, 30, 1000);
  assert.equal(dots.length, 1);
  assert.equal(dots[0].speakerId, 1);
  assert.equal(dots[0].worldAngleDeg, 30);
  assert.equal(dots[0].lastSpokenMs, 1000);
  assert.equal(dots[0].speaking, false);
});

test("a nearby utterance smooths the dot instead of jumping", () => {
  let dots = placeDotForUtterance([], alice, 30, 1000);
  dots = placeDotForUtterance(dots, alice, 50, 2000);
  // Halfway with MOVE_SMOOTHING = 0.5.
  assert.equal(dots.length, 1);
  assert.equal(dots[0].worldAngleDeg, 40);
  assert.equal(dots[0].lastSpokenMs, 2000);
});

test("a distant utterance snaps: the person actually moved", () => {
  let dots = placeDotForUtterance([], alice, 0, 1000);
  dots = placeDotForUtterance(dots, alice, 120, 2000);
  assert.equal(dots[0].worldAngleDeg, 120);
});

test("trackSpeakingDot marks the nearest dot and glides it toward the live DOA", () => {
  let dots = placeDotForUtterance([], alice, 0, 1000);
  dots = placeDotForUtterance(dots, bob, 90, 1000);
  const matched = trackSpeakingDot(dots, 100, 2000);
  assert.equal(matched, true);
  const bobDot = dots.find((dot) => dot.speakerId === 2);
  const aliceDot = dots.find((dot) => dot.speakerId === 1);
  assert.equal(bobDot.speaking, true);
  assert.equal(bobDot.lastSpokenMs, 2000);
  // Glided a quarter of the way (LIVE_SMOOTHING = 0.25).
  assert.equal(bobDot.worldAngleDeg, 92.5);
  assert.equal(aliceDot.speaking, false);
  assert.equal(aliceDot.lastSpokenMs, 1000);
});

test("trackSpeakingDot ignores voices far from every known dot", () => {
  const dots = placeDotForUtterance([], alice, 0, 1000);
  dots[0].speaking = true;
  const matched = trackSpeakingDot(dots, 90, 2000);
  assert.equal(matched, false);
  assert.equal(dots[0].speaking, false);
  assert.equal(dots[0].worldAngleDeg, 0);
});

test("clearSpeaking silences every dot", () => {
  const dots = placeDotForUtterance([], alice, 0, 1000);
  trackSpeakingDot(dots, 5, 2000);
  assert.equal(dots[0].speaking, true);
  clearSpeaking(dots);
  assert.equal(dots[0].speaking, false);
});

test("pruneDots drops speakers silent past the TTL", () => {
  let dots = placeDotForUtterance([], alice, 0, 0);
  dots = placeDotForUtterance(dots, bob, 90, SPEAKER_DOT_TTL_MS);
  const pruned = pruneDots(dots, SPEAKER_DOT_TTL_MS + 1);
  assert.equal(pruned.length, 1);
  assert.equal(pruned[0].speakerId, 2);
});

test("brightness: full while speaking, fading with silence age", () => {
  const dots = placeDotForUtterance([], alice, 0, 0);
  const dot = dots[0];
  dot.speaking = true;
  assert.equal(dotBrightness(dot, 0), 255);
  dot.speaking = false;
  const fresh = dotBrightness(dot, 0);
  const halfway = dotBrightness(dot, SPEAKER_DOT_TTL_MS / 2);
  const expired = dotBrightness(dot, SPEAKER_DOT_TTL_MS);
  assert.equal(fresh, 220);
  assert.ok(halfway < fresh && halfway > expired);
  assert.equal(expired, 80);
});
