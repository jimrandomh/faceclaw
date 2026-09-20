const test = require("node:test");
const assert = require("node:assert/strict");

const { chargingDisplayLabel, glassesDisplayLabel } = require("../.test-build/app/g2/glasses-display-state.js");

const connected = {
  phase: "connected",
  silentMode: false,
  screenOn: true,
  battery: 72,
  foregroundTitle: "Music",
};

test("the foreground-title line covers visible, dark, and silent displays", () => {
  assert.equal(glassesDisplayLabel(connected), "Music");
  assert.equal(glassesDisplayLabel({ ...connected, foregroundTitle: null }), "Launcher");
  assert.equal(glassesDisplayLabel({ ...connected, screenOn: false }), "Display off");
  assert.equal(glassesDisplayLabel({ ...connected, screenOn: false, silentMode: true }), "Silent mode");
});

test("charging takes precedence and includes the last-known G2 battery", () => {
  assert.equal(
    glassesDisplayLabel({ ...connected, phase: "charging", silentMode: true, screenOn: false }),
    "Charging · G2 72%",
  );
  assert.equal(chargingDisplayLabel(null), "Charging");
  assert.equal(chargingDisplayLabel(-1), "Charging");
  assert.equal(chargingDisplayLabel(101), "Charging");
});
