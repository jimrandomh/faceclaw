// These pin the parts the pairing screen depends on: that a stronger signal
// always sorts first, that the absolute numbers stay inside a plausible band,
// and that a missing signal degrades to "unknown" rather than to a fabricated
// distance.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  estimateProximity,
  GLASSES_CALIBRATION,
  RING_CALIBRATION,
  MINIMUM_METERS,
  MAXIMUM_METERS,
  zoneFromMeters,
  zoneLabel,
  sortedByProximity,
} = require("../.test-build/app/g2/ble-proximity.js");

const near = (a, b, eps) => Math.abs(a - b) <= eps;

test("distance falls as signal weakens", () => {
  const close = estimateProximity(-40, GLASSES_CALIBRATION);
  const mid = estimateProximity(-70, GLASSES_CALIBRATION);
  const farAway = estimateProximity(-95, GLASSES_CALIBRATION);
  assert.ok(close.meters < mid.meters);
  assert.ok(mid.meters < farAway.meters);
});

test("the reference power reads as one metre", () => {
  const estimate = estimateProximity(GLASSES_CALIBRATION.txPowerAtOneMeter, GLASSES_CALIBRATION);
  assert.ok(near(estimate.meters, 1.0, 0.001));
  assert.equal(estimate.zone, "near");
});

test("estimates stay inside a plausible band", () => {
  assert.ok(near(estimateProximity(20, GLASSES_CALIBRATION).meters, MINIMUM_METERS, 0.0001));
  assert.ok(near(estimateProximity(-127, GLASSES_CALIBRATION).meters, MAXIMUM_METERS, 0.0001));
});

test("the calibration table is the only reference power", () => {
  // An advertised BLE "TX Power Level" is radiated power at the antenna, not a
  // measured power at 1 m; estimateProximity deliberately takes no TX power
  // argument, so a 0 dBm advertisement cannot inflate the estimate. The API
  // itself enforces it — this pins the arity so a txPower parameter cannot
  // quietly return.
  assert.equal(estimateProximity.length, 2);
});

test("no signal yields no estimate (127 is the unavailable sentinel)", () => {
  assert.equal(estimateProximity(null, GLASSES_CALIBRATION), null);
  assert.equal(estimateProximity(undefined, GLASSES_CALIBRATION), null);
  assert.equal(estimateProximity(127, GLASSES_CALIBRATION), null);
});

test("zones and their boundaries", () => {
  assert.equal(zoneFromMeters(0.2), "immediate");
  assert.equal(zoneFromMeters(0.5), "near");
  assert.equal(zoneFromMeters(2.9), "near");
  assert.equal(zoneFromMeters(3), "far");
  assert.equal(zoneFromMeters(9.9), "far");
  assert.equal(zoneFromMeters(10), "distant");
  assert.equal(zoneLabel("immediate"), "In your hand");
});

test("weak signals carry lower confidence", () => {
  const strong = estimateProximity(-45, GLASSES_CALIBRATION);
  const weak = estimateProximity(-95, GLASSES_CALIBRATION);
  assert.ok(weak.confidence < strong.confidence);
});

const device = (id, rssi) => ({ id, rssi });
const estimate = (d) => estimateProximity(d.rssi, GLASSES_CALIBRATION);
const byId = (d) => d.id;

test("glasses sort closest first", () => {
  const sorted = sortedByProximity([device("1", -80), device("2", -40), device("3", -60)], estimate, byId);
  assert.deepEqual(sorted.map(byId), ["2", "3", "1"]);
});

test("devices without a signal sort last and are not dropped", () => {
  const sorted = sortedByProximity([device("silent", null), device("heard", -70)], estimate, byId);
  assert.deepEqual(sorted.map(byId), ["heard", "silent"]);
});

test("equal signals keep a stable order", () => {
  const forward = sortedByProximity([device("b", -60), device("a", -60)], estimate, byId);
  const reversed = sortedByProximity([device("a", -60), device("b", -60)], estimate, byId);
  assert.deepEqual(forward.map(byId), ["a", "b"]);
  assert.deepEqual(reversed.map(byId), forward.map(byId));
});

test("ring and glasses are calibrated separately", () => {
  // The ring's antenna reads weaker than the glasses at the same distance, so
  // the same RSSI must not be reported as the same distance for both.
  const ring = estimateProximity(-70, RING_CALIBRATION);
  const glasses = estimateProximity(-70, GLASSES_CALIBRATION);
  assert.ok(ring.meters < glasses.meters);
});
