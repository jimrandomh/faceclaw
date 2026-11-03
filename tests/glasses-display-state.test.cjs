const test = require("node:test");
const assert = require("node:assert/strict");

const {
  chargingDisplayLabel,
  chargingPreviewMessage,
  formatBatteryLine,
  glassesDisplayAsleep,
  glassesDisplayDetail,
  glassesDisplayLabel,
} = require("../.test-build/app/g2/glasses-display-state.js");

const connected = {
  phase: "connected",
  silentMode: false,
  screenOn: true,
  battery: 72,
  caseBattery: null,
  caseCharging: null,
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

test("while charging, the case level is the watch face's second line and joins the mirror's message", () => {
  const charging = { ...connected, phase: "charging", caseBattery: 64, caseCharging: false };
  assert.equal(glassesDisplayLabel(charging), "Charging · G2 72%");
  assert.equal(glassesDisplayDetail(charging), "Case 64%");
  assert.equal(glassesDisplayDetail({ ...charging, caseCharging: true }), "Case 64% ⚡");
  assert.equal(chargingPreviewMessage(charging), "Charging · G2 72% · Case 64%");
  // No case level yet: the label alone.
  assert.equal(glassesDisplayDetail({ ...charging, caseBattery: null }), "");
  assert.equal(chargingPreviewMessage({ ...charging, caseBattery: null, battery: null }), "Charging");
  // Out of the case the level is stale, so it is not shown.
  assert.equal(glassesDisplayDetail({ ...connected, caseBattery: 64 }), "");
});

const levels = {
  headset: 87, headsetCharging: true, case: 64, caseCharging: true, ring: 72, ringCharging: false,
};

test("the Settings battery line lists each known level, with ⚡ only while the reading is live", () => {
  assert.equal(formatBatteryLine(levels, true), "G2 87% ⚡  ·  Case 64% ⚡  ·  R1 72%");
  // Without a link to the glasses their charging state and the case's are stale.
  assert.equal(formatBatteryLine({ ...levels, ringCharging: true }, false), "G2 87%  ·  Case 64%  ·  R1 72% ⚡");
  // caseCharging is null while the glasses are out of the case.
  assert.equal(formatBatteryLine({ ...levels, caseCharging: null }, true), "G2 87% ⚡  ·  Case 64%  ·  R1 72%");
  assert.equal(formatBatteryLine({ ...levels, case: null, ring: null }, true), "G2 87% ⚡");
  assert.equal(
    formatBatteryLine({ headset: null, headsetCharging: null, case: null, caseCharging: null, ring: null, ringCharging: null }, true),
    "",
  );
});
