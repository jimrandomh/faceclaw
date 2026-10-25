// The stock DeviceStatus an EvenHub app sees (getGlassesInfo().status and the
// deviceStatusChanged push), built from Faceclaw's view of the glasses.
const test = require("node:test");
const assert = require("node:assert/strict");

const { buildEvenHubDeviceStatus, sameDeviceStatus, PLACEHOLDER_SERIAL } = require("../.test-build/app/apps/evenhub/device-status.js");

const worn = { serial: "S200LAAJ0123", connected: true, worn: true, battery: 73, charging: false };

test("connected, worn glasses report their real values", () => {
  assert.deepEqual(buildEvenHubDeviceStatus(worn), {
    sn: "S200LAAJ0123",
    connectType: "connected",
    isWearing: true,
    batteryLevel: 73,
    isCharging: false,
    isInCase: false,
  });
});

test("charging means in the case, since the G2 only charges there", () => {
  const status = buildEvenHubDeviceStatus({ ...worn, worn: false, charging: true });
  assert.equal(status.isCharging, true);
  assert.equal(status.isInCase, true);
  assert.equal(status.isWearing, false);
});

test("unknown wear state and battery are omitted, not guessed", () => {
  const status = buildEvenHubDeviceStatus({ serial: null, connected: false, worn: null, battery: null, charging: false });
  assert.deepEqual(status, { sn: PLACEHOLDER_SERIAL, connectType: "disconnected", isCharging: false, isInCase: false });
  assert.equal("isWearing" in status, false);
  assert.equal("batteryLevel" in status, false);
});

test("a blank serial falls back to the placeholder", () => {
  assert.equal(buildEvenHubDeviceStatus({ ...worn, serial: "  " }).sn, PLACEHOLDER_SERIAL);
});

test("sameDeviceStatus compares every field", () => {
  const a = buildEvenHubDeviceStatus(worn);
  assert.equal(sameDeviceStatus(a, buildEvenHubDeviceStatus(worn)), true);
  assert.equal(sameDeviceStatus(a, buildEvenHubDeviceStatus({ ...worn, battery: 72 })), false);
  assert.equal(sameDeviceStatus(a, buildEvenHubDeviceStatus({ ...worn, worn: null })), false);
  assert.equal(sameDeviceStatus(a, buildEvenHubDeviceStatus({ ...worn, connected: false })), false);
});
