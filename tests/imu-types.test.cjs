const test = require("node:test");
const assert = require("node:assert/strict");

const { imuPitchDegrees } = require("../.test-build/app/native/imu-types.js");

const rad = (deg) => (deg * Math.PI) / 180;

/**
 * A reading at rest in the canonical frame (+x forward, +y left, +z up), in
 * m/s^2 to show the scale does not matter: the head pitched up by pitchDeg,
 * then rolled by rollDeg.
 */
function reading(pitchDeg, rollDeg = 0) {
  const p = rad(pitchDeg);
  const r = rad(rollDeg);
  return { x: 9.8 * Math.sin(p), y: 9.8 * Math.cos(p) * Math.sin(r), z: 9.8 * Math.cos(p) * Math.cos(r) };
}

test("imuPitchDegrees reads the head's pitch from one reading, past 45° and with the head rolled", () => {
  for (const pitch of [-30, 0, 5, 20, 45, 50, 60, 75]) {
    for (const roll of [0, 30, -40]) {
      assert.ok(Math.abs(imuPitchDegrees(reading(pitch, roll)) - pitch) < 1e-6, `pitch ${pitch} roll ${roll}`);
    }
  }
  // The poses measured on a G2 (in g).
  const s = Math.SQRT1_2;
  assert.ok(Math.abs(imuPitchDegrees({ x: 0, y: 0, z: 1 })) < 1e-9);
  assert.ok(Math.abs(imuPitchDegrees({ x: s, y: 0, z: s }) - 45) < 1e-9);
  assert.ok(Math.abs(imuPitchDegrees({ x: 0, y: s, z: s })) < 1e-9);
});
