const test = require("node:test");
const assert = require("node:assert/strict");

const { chargingDisplayLabel, glassesDisplayAsleep, glassesDisplayLabel } = require("../.test-build/app/g2/glasses-display-state.js");

const connected = {
  phase: "connected",
  silentMode: false,
  screenOn: true,
  battery: 72,
  foregroundTitle: "Music",
  previewMode: false,
};

test("the foreground-title line covers visible, dark, and silent displays", () => {
  assert.equal(glassesDisplayLabel(connected), "Music");
  assert.equal(glassesDisplayLabel({ ...connected, foregroundTitle: null }), "Launcher");
  assert.equal(glassesDisplayLabel({ ...connected, screenOn: false }), "Display off");
  assert.equal(glassesDisplayLabel({ ...connected, screenOn: false, silentMode: true }), "Silent mode");
});

test("only the Display off state counts as asleep (the watch face's wake hint)", () => {
  assert.equal(glassesDisplayAsleep({ ...connected, screenOn: false }), true);
  assert.equal(glassesDisplayAsleep({ ...connected, phase: "disconnected", screenOn: false, previewMode: true }), true);
  assert.equal(glassesDisplayAsleep(connected), false);
  assert.equal(glassesDisplayAsleep({ ...connected, screenOn: false, silentMode: true }), false);
  assert.equal(glassesDisplayAsleep({ ...connected, phase: "charging", screenOn: false }), false);
  assert.equal(glassesDisplayAsleep({ ...connected, phase: "disconnected", screenOn: false }), false);
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
