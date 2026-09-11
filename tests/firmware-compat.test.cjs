// Pins the firmware-extension parsing and the compatibility / onboarding
// classification that the firmware check page and the main screen share.
const test = require("node:test");
const assert = require("node:assert/strict");

const compat = require("../.test-build/app/g2/firmware-compat.js");

const REQUIRED = compat.REQUIRED_FACECLAW_FIRMWARE_VERSION;
const info = (extension, left = "2.2.9.22", right = "2.2.9.22") => ({ leftVersion: left, rightVersion: right, extension });

test("parseFirmwareExtension recognizes each slot format", () => {
  assert.deepEqual(compat.parseFirmwareExtension(""), { kind: "none" });
  assert.deepEqual(compat.parseFirmwareExtension("  "), { kind: "none" });
  assert.deepEqual(compat.parseFirmwareExtension("Faceclaw/1"), { kind: "faceclaw", version: 1 });
  assert.deepEqual(compat.parseFirmwareExtension(" Faceclaw/12 "), { kind: "faceclaw", version: 12 });
  assert.deepEqual(compat.parseFirmwareExtension("EVENCFW/22 img640 imgz rle"), {
    kind: "legacy-faceclaw",
    text: "EVENCFW/22 img640 imgz rle",
  });
  assert.deepEqual(compat.parseFirmwareExtension("EVENCFW"), { kind: "legacy-faceclaw", text: "EVENCFW" });
  assert.deepEqual(compat.parseFirmwareExtension("OtherCFW/3"), { kind: "other", text: "OtherCFW/3" });
  // A Faceclaw prefix without a usable number is not ours.
  assert.deepEqual(compat.parseFirmwareExtension("Faceclaw/x"), { kind: "other", text: "Faceclaw/x" });
});

test("the required revision and newer revisions are compatible", () => {
  assert.equal(compat.hasCompatibleFirmware(info(`Faceclaw/${REQUIRED}`)), true);
  assert.equal(compat.firmwareIncompatibilityMessage(info(`Faceclaw/${REQUIRED}`)), null);
  assert.equal(compat.hasCompatibleFirmware(info(`Faceclaw/${REQUIRED + 5}`)), true);
  assert.equal(compat.firmwareIncompatibilityMessage(info(`Faceclaw/${REQUIRED + 5}`)), null);
  assert.equal(compat.classifyOnboardingFirmware(info(`Faceclaw/${REQUIRED + 5}`)).kind, "custom");
});

test("older Faceclaw revisions and legacy EVENCFW builds need a reflash", () => {
  const older = info(`Faceclaw/${REQUIRED - 1}`);
  assert.equal(compat.hasCompatibleFirmware(older), false);
  assert.match(compat.firmwareIncompatibilityMessage(older), /revision 0/);
  assert.match(compat.firmwareIncompatibilityMessage(older), new RegExp(`requires revision ${REQUIRED}`));
  assert.equal(compat.classifyOnboardingFirmware(older).kind, "older-faceclaw");

  const legacy = info("EVENCFW/22 img640 fbguard wearnotify");
  assert.equal(compat.hasCompatibleFirmware(legacy), false);
  assert.match(compat.firmwareIncompatibilityMessage(legacy), /older version of Faceclaw's custom firmware/);
  const classified = compat.classifyOnboardingFirmware(legacy);
  assert.equal(classified.kind, "older-faceclaw");
  assert.equal(classified.version, "2.2.9.22");
  assert.equal(classified.extension.kind, "legacy-faceclaw");
});

test("custom firmware from another source is flashable with its own messaging", () => {
  const other = info("OtherCFW/3", "2.2.9.22", "2.2.9.22");
  assert.equal(compat.hasCompatibleFirmware(other), false);
  assert.match(compat.firmwareIncompatibilityMessage(other), /different source/);
  assert.match(compat.firmwareIncompatibilityMessage(other), /OtherCFW\/3/);
  assert.equal(compat.classifyOnboardingFirmware(other).kind, "other-custom");
  assert.match(compat.describeFirmwareExtension({ kind: "other", text: "OtherCFW/3" }), /different source/);
});

test("stock firmware classifies by base version and warns on the main screen", () => {
  assert.equal(compat.firmwareIncompatibilityMessage(info("", "", "")), null, "nothing reported is not a verdict");
  assert.match(compat.firmwareIncompatibilityMessage(info("")), /stock firmware/);
  assert.equal(compat.classifyOnboardingFirmware(info("", "", "")).kind, "unknown");
  assert.equal(compat.classifyOnboardingFirmware(info("", "2.2.9.22", "2.2.9.22")).kind, "flashable-stock");
  assert.equal(compat.classifyOnboardingFirmware(info("", "2.2.4.34", "")).kind, "flashable-stock");
  assert.equal(compat.classifyOnboardingFirmware(info("", "2.2.10.10", "2.2.10.10")).kind, "newer-stock-validated");
  assert.equal(compat.classifyOnboardingFirmware(info("", "2.3.0.1", "2.3.0.1")).kind, "newer-stock-unvalidated");
  // Faceclaw firmware on a newer base is still judged by its revision, not the base.
  assert.equal(compat.classifyOnboardingFirmware(info(`Faceclaw/${REQUIRED}`, "2.3.0.1", "2.3.0.1")).kind, "custom");
});

test("reportedFirmwareVersion picks the higher arm", () => {
  assert.equal(compat.reportedFirmwareVersion(info("", "2.2.9.22", "2.2.10.10")), "2.2.10.10");
  assert.equal(compat.reportedFirmwareVersion(info("", "", "2.2.9.22")), "2.2.9.22");
  assert.equal(compat.reportedFirmwareVersion(info("", "", "")), "");
});
