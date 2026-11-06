const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_GLANCE_ANGLE,
  MIN_GLANCE_ANGLE,
  angleBetweenDegrees,
  glanceAngleForTilt,
  meanVector,
  roundGlanceAngle,
} = require("../.test-build/app/g2/head-tilt-math.js");

const rad = (deg) => (deg * Math.PI) / 180;

/**
 * Gravity (m/s^2) after pitching the head by pitchDeg, in a sensor frame
 * mounted so that no axis lines up with the head: the level reading points
 * along an arbitrary direction, and the pitch rotates it about an arbitrary
 * axis perpendicular to that (Rodrigues' formula).
 */
function gravityPitched(pitchDeg) {
  const v = normalize({ x: 0.3, y: -0.9, z: 0.2 });
  const k0 = { x: 0.9, y: 0.4, z: 0.45 };
  const dot = k0.x * v.x + k0.y * v.y + k0.z * v.z;
  const k = normalize({ x: k0.x - dot * v.x, y: k0.y - dot * v.y, z: k0.z - dot * v.z });
  const c = Math.cos(rad(pitchDeg));
  const s = Math.sin(rad(pitchDeg));
  const cross = { x: k.y * v.z - k.z * v.y, y: k.z * v.x - k.x * v.z, z: k.x * v.y - k.y * v.x };
  return { x: 9.8 * (v.x * c + cross.x * s), y: 9.8 * (v.y * c + cross.y * s), z: 9.8 * (v.z * c + cross.z * s) };
}

function normalize(v) {
  const m = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / m, y: v.y / m, z: v.z / m };
}

test("the tilt between two readings does not depend on the sensor's axes, past 45° too", () => {
  const level = gravityPitched(0);
  for (const pitch of [5, 20, 30, 45, 50, 60, 75]) {
    assert.ok(Math.abs(angleBetweenDegrees(level, gravityPitched(pitch)) - pitch) < 1e-6, `pitch ${pitch}`);
  }
  // From a non-zero level reading the difference is what counts.
  assert.ok(Math.abs(angleBetweenDegrees(gravityPitched(-10), gravityPitched(40)) - 50) < 1e-6);
  assert.ok(Math.abs(angleBetweenDegrees(level, level)) < 1e-6);
});

test("meanVector averages and rejects empty or zero input", () => {
  assert.deepEqual(meanVector([{ x: 1, y: 2, z: 3 }, { x: 3, y: 2, z: 1 }]), { x: 2, y: 2, z: 2 });
  assert.equal(meanVector([]), null);
  assert.equal(meanVector([{ x: 0, y: 0, z: 0 }]), null);
});

test("roundGlanceAngle rounds to 5° within the setting's range", () => {
  assert.equal(roundGlanceAngle(27.4), 25);
  assert.equal(roundGlanceAngle(27.5), 30);
  assert.equal(roundGlanceAngle(1), MIN_GLANCE_ANGLE);
  assert.equal(roundGlanceAngle(80), MAX_GLANCE_ANGLE);
});

test("glanceAngleForTilt reports a head that did not move or went too far instead of clamping", () => {
  assert.deepEqual(glanceAngleForTilt(31), { ok: true, rounded: 30 });
  assert.deepEqual(glanceAngleForTilt(52), { ok: true, rounded: 50 });
  assert.deepEqual(glanceAngleForTilt(3), { ok: true, rounded: 5 });
  assert.equal(glanceAngleForTilt(0.5).ok, false);
  assert.equal(glanceAngleForTilt(65).ok, false);
  assert.equal(glanceAngleForTilt(NaN).ok, false);
});
