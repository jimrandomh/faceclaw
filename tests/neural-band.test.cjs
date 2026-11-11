const test = require("node:test");
const assert = require("node:assert/strict");

const {
  neuralBandBatteryLevel,
  neuralBandBatteryText,
  neuralBandInputFor,
  neuralBandStatusLine,
} = require("../.test-build/app/g2/neural-band-core.js");
const { UNSUPPORTED_STATUS, parseNeuralBandEvent } = require("../.test-build/app/native/neural-band-types.js");

const status = (overrides) => ({ ...UNSUPPORTED_STATUS, supported: true, ...overrides });

test("index pinches select and go back; middle pinches open the app menu", () => {
  assert.equal(neuralBandInputFor("tap", 0), "click");
  assert.equal(neuralBandInputFor("double-tap", 0), "double-click");
  assert.equal(neuralBandInputFor("tap", 1), "short-then-long-press");
  assert.equal(neuralBandInputFor("double-tap", 1), "double-click");
});

test("every pinch announces its touch-down; holds and releases are paired elsewhere", () => {
  assert.equal(neuralBandInputFor("press", 0), "ring-press");
  assert.equal(neuralBandInputFor("press", 1), "ring-press");
  assert.equal(neuralBandInputFor("hold", 1), null);
  assert.equal(neuralBandInputFor("release", 1), null);
});

test("thumb swipes stay four-way and the dial scrolls", () => {
  for (const direction of ["up", "down", "left", "right"]) {
    assert.equal(neuralBandInputFor(`swipe-${direction}`, undefined), `swipe-${direction}`);
  }
  assert.equal(neuralBandInputFor("dial-up", undefined), "scroll-up");
  assert.equal(neuralBandInputFor("dial-down", undefined), "scroll-down");
  assert.equal(neuralBandInputFor("wave", undefined), null);
});

test("status lines say what the band is doing", () => {
  assert.match(neuralBandStatusLine(UNSUPPORTED_STATUS), /Android 10/);
  assert.match(neuralBandStatusLine(status({})), /No band paired/);
  assert.equal(
    neuralBandStatusLine(status({ paired: true, name: "Meta Band 1A2B", state: "connected", battery: 84, charging: true })),
    "Connected to Meta Band 1A2B (84%, charging).",
  );
  assert.equal(neuralBandStatusLine(status({ paired: true, state: "connected" })), "Connected to Neural Band.");
  assert.equal(
    neuralBandStatusLine(status({ paired: true, state: "claiming", message: "Claiming the band…" })),
    "Setting up Neural Band: Claiming the band…",
  );
  assert.equal(neuralBandStatusLine(status({ paired: true, state: "disconnected" })), "Neural Band is paired but not connected.");
  assert.equal(neuralBandBatteryText(status({ battery: -1 })), "");
  assert.equal(neuralBandBatteryText(status({ battery: 5, charging: false })), "5%");
});

test("native events parse, and a status fills in fields an older native side leaves out", () => {
  const parsed = parseNeuralBandEvent(JSON.stringify({ type: "status", supported: true, state: "connected", battery: 50 }));
  assert.equal(parsed.type, "status");
  assert.equal(parsed.state, "connected");
  assert.equal(parsed.battery, 50);
  assert.equal(parsed.hand, null);
  assert.deepEqual(parseNeuralBandEvent('{"type":"gesture","gesture":"tap","finger":1}'), { type: "gesture", gesture: "tap", finger: 1 });
  assert.equal(parseNeuralBandEvent("{"), null);
  assert.equal(parseNeuralBandEvent('{"type":"mystery"}'), null);
});

test("the battery indicator follows the band: a level only while connected and reported", () => {
  assert.deepEqual(neuralBandBatteryLevel(status({ state: "connected", battery: 64, charging: false })), { band: 64, bandCharging: false });
  // Charging stays unknown until the band's own status query has said.
  assert.deepEqual(neuralBandBatteryLevel(status({ state: "connected", battery: 64, charging: null })), { band: 64, bandCharging: null });
  assert.deepEqual(neuralBandBatteryLevel(status({ state: "connected", battery: -1 })), { band: null, bandCharging: null });
  // A disconnected band takes its indicator with it, whatever it last said.
  assert.deepEqual(neuralBandBatteryLevel(status({ state: "connecting", battery: 64, charging: true })), { band: null, bandCharging: null });
  assert.deepEqual(neuralBandBatteryLevel(status({ state: "connected", battery: 101 })), { band: null, bandCharging: null });
});
