// The caption clock maps the engine's fed-audio clock to wall time, so a
// line's timestamp stays right after audio that never reached the engine
// (beam filter, voice-dialog pause, stall) or arrived late in a burst.
const test = require("node:test");
const assert = require("node:assert/strict");

const { CaptionClock, CAPTION_CLOCK_DRIFT_MS } = require("../.test-build/app/apps/microphones/caption-clock.js");

const RATE = 16000;
// 50 ms of 16 kHz mono S16LE.
const CHUNK_BYTES = 1600;
const CHUNK_MS = 50;

function feed(clock, startWallMs, chunks, intervalMs = CHUNK_MS) {
  for (let i = 0; i < chunks; i++) clock.noteFed(CHUNK_BYTES, startWallMs + (i + 1) * intervalMs);
}

test("real-time audio maps straight through", () => {
  const clock = new CaptionClock(RATE, 1_000_000);
  feed(clock, 1_000_000, 100);
  assert.equal(clock.wallMs(0), 1_000_000);
  assert.equal(clock.wallMs(2_500), 1_002_500);
});

test("before any audio, times count from the start", () => {
  const clock = new CaptionClock(RATE, 5_000);
  assert.equal(clock.wallMs(120), 5_120);
});

test("a gap in the audio moves later times past it", () => {
  const clock = new CaptionClock(RATE, 0);
  feed(clock, 0, 20); // engine 0..1000 ms at wall 0..1000
  feed(clock, 61_000, 20); // a minute paused, then 1000 ms more
  assert.equal(clock.wallMs(500), 500);
  assert.equal(clock.wallMs(1_000), 61_000);
  assert.equal(clock.wallMs(1_500), 61_500);
});

test("many small dropped chunks don't accumulate past the drift bound", () => {
  const clock = new CaptionClock(RATE, 0);
  // Every other 50 ms chunk is dropped (beam filter): fed audio runs at half speed.
  for (let i = 0; i < 400; i++) clock.noteFed(CHUNK_BYTES, (i + 1) * 2 * CHUNK_MS);
  const engineMs = 399 * CHUNK_MS;
  const actualWall = 400 * 2 * CHUNK_MS - CHUNK_MS;
  assert.ok(Math.abs(clock.wallMs(engineMs) - actualWall) <= CAPTION_CLOCK_DRIFT_MS + CHUNK_MS);
});

test("jitter within the bound doesn't re-anchor", () => {
  const clock = new CaptionClock(RATE, 0);
  for (let i = 0; i < 100; i++) {
    const jitter = i % 2 === 0 ? 120 : 0;
    clock.noteFed(CHUNK_BYTES, (i + 1) * CHUNK_MS + jitter);
  }
  // Anchored once, by the first chunk (which arrived 120 ms late).
  assert.equal(clock.wallMs(1_000), 1_120);
});

test("a late burst re-anchors once the stream is real-time again", () => {
  const clock = new CaptionClock(RATE, 0);
  feed(clock, 0, 20); // 0..1000 ms on time
  // 2 s of audio held up, then delivered all at once at wall 3000.
  for (let i = 0; i < 40; i++) clock.noteFed(CHUNK_BYTES, 3_000);
  // Then real-time again.
  feed(clock, 3_000, 40);
  // Engine 3000 ms (fed during real-time after the burst) lands near wall 3000.
  assert.ok(Math.abs(clock.wallMs(3_000) - 3_000) <= CAPTION_CLOCK_DRIFT_MS + CHUNK_MS);
  assert.ok(Math.abs(clock.wallMs(4_500) - 4_500) <= CAPTION_CLOCK_DRIFT_MS + CHUNK_MS);
});
