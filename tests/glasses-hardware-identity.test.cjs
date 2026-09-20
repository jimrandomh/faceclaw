// The reference mapping is the Even Realities app 2.2.0 (`_parseGlassesSku`,
// `evenSNName`, `matchModel`). `S211GBBC180304` and `S211GCBC300403` are
// serials observed on real hardware, so they are the anchors here rather than
// synthetic strings.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  GlassesHardwareIdentity,
  evaluatePairSerials,
  pairSerialWarning,
  BUNDLED_VARIANT_ASSET_NAMES,
} = require("../.test-build/app/g2/glasses-hardware-identity.js");

test("decodes an observed G2 serial", () => {
  const identity = GlassesHardwareIdentity.decode("S211GBBC180304");
  assert.ok(identity);
  assert.equal(identity.family, "g2");
  assert.equal(identity.frame, "b");
  assert.equal(identity.colorway, "brown");
  assert.equal(identity.modelCode, "S211");
  assert.equal(identity.shortSerial, "0304");
  assert.equal(identity.productName, "Even G2 B");
  assert.equal(identity.variantSummary, "Frame B · Brown");
  assert.equal(identity.displayName, "Even G2 B · Brown");
});

test("colour byte at index five selects the finish", () => {
  assert.equal(GlassesHardwareIdentity.decode("S211GAAA000001").colorway, "grey");
  assert.equal(GlassesHardwareIdentity.decode("S211GBBC180304").colorway, "brown");
  assert.equal(GlassesHardwareIdentity.decode("S211GCBC300403").colorway, "green");
});

test("frame prefix table", () => {
  assert.equal(GlassesHardwareIdentity.decode("S201GAAA000001").frame, "a");
  assert.equal(GlassesHardwareIdentity.decode("S281GAAA000001").frame, "a");
  assert.equal(GlassesHardwareIdentity.decode("S211GAAA000001").frame, "b");
  assert.equal(GlassesHardwareIdentity.decode("S291GAAA000001").frame, "b");
  assert.equal(GlassesHardwareIdentity.decode("S221GAAA000001").frame, "c");
});

test("unknown G2 prefix keeps the family but claims no shape", () => {
  // The Even app defaults an unknown prefix to frame A. Identification cannot
  // afford that: a future SKU must read as "Even G2" with no shape claim.
  const identity = GlassesHardwareIdentity.decode("S231GBAA000001");
  assert.equal(identity.family, "g2");
  assert.equal(identity.frame, null);
  assert.equal(identity.colorway, "brown");
  assert.equal(identity.productName, "Even G2");
  assert.equal(identity.variantSummary, "Brown");
});

test("unknown colour byte claims no finish", () => {
  const identity = GlassesHardwareIdentity.decode("S211GZAA000001");
  assert.equal(identity.frame, "b");
  assert.equal(identity.colorway, null);
  assert.equal(identity.displayName, "Even G2 B");
  assert.equal(identity.variantSummary, "Frame B");
});

test("bench-unit colour byte D (seen in HCI capture) decodes to no finish", () => {
  const identity = GlassesHardwareIdentity.decode("S200LDBE210001");
  assert.equal(identity.frame, "a");
  assert.equal(identity.colorway, null);
});

test("G1 and ring families", () => {
  const g1 = GlassesHardwareIdentity.decode("S110GAAA000001");
  assert.equal(g1.family, "g1");
  assert.equal(g1.frame, "b");
  assert.equal(g1.productName, "Even G1 B");
  assert.equal(GlassesHardwareIdentity.decode("S100GAAA000001").frame, "a");

  // The ring has neither a frame shape nor a colourway in the Even app's model.
  const ring = GlassesHardwareIdentity.decode("B210GAAA000001");
  assert.equal(ring.family, "r1");
  assert.equal(ring.frame, null);
  assert.equal(ring.colorway, null);
  assert.equal(ring.variantSummary, null);
  assert.equal(ring.displayName, "Even R1");
});

test("arm suffix and case are normalized away", () => {
  const suffixed = GlassesHardwareIdentity.decode("S211GBBC180304_L_1");
  const lowercased = GlassesHardwareIdentity.decode(" s211gbbc180304 ");
  assert.equal(suffixed.serial, "S211GBBC180304");
  assert.ok(suffixed.equals(lowercased));
});

test("rejects non-Even and truncated serials", () => {
  assert.equal(GlassesHardwareIdentity.decode("EVEN_G2_ALPHA"), null);
  assert.equal(GlassesHardwareIdentity.decode("Even G2_32_L_ACD458"), null);
  assert.equal(GlassesHardwareIdentity.decode("S211G"), null);
  assert.equal(GlassesHardwareIdentity.decode(""), null);
  assert.equal(GlassesHardwareIdentity.decode(null), null);
  assert.equal(GlassesHardwareIdentity.decode(undefined), null);
});

test("known SKUs resolve to their own artwork; frame C and the ring fall back", () => {
  assert.equal(GlassesHardwareIdentity.decode("S211GBBC180304").imageAssetName, "glasses_g2_b_brown");
  assert.equal(GlassesHardwareIdentity.decode("S201GAAA000001").imageAssetName, "glasses_g2_a_grey");
  assert.equal(GlassesHardwareIdentity.decode("S221GAAA000001").imageAssetName, null);
  assert.equal(GlassesHardwareIdentity.decode("B210GAAA000001").imageAssetName, null);
  assert.equal(BUNDLED_VARIANT_ASSET_NAMES.size, 6);
});

test("pair serial check verdicts", () => {
  assert.deepEqual(evaluatePairSerials("S211GBBC180304", "S211GBBC180304"), { kind: "matched", serial: "S211GBBC180304" });
  // The arm suffix and casing differ but the hardware does not.
  assert.deepEqual(evaluatePairSerials("S211GBBC180304_L_1", "s211gbbc180304"), { kind: "matched", serial: "S211GBBC180304" });
  assert.deepEqual(evaluatePairSerials("S211GBBC180304", "S211GCBC300403"), {
    kind: "mismatched",
    left: "S211GBBC180304",
    right: "S211GCBC300403",
  });
  assert.deepEqual(evaluatePairSerials("S211GBBC180304", null), { kind: "unknown" });
  assert.deepEqual(evaluatePairSerials(null, null), { kind: "unknown" });
  assert.deepEqual(evaluatePairSerials("  ", "S211GBBC180304"), { kind: "unknown" });
});

test("pair serial warning names both serials and only fires on mismatch", () => {
  assert.equal(pairSerialWarning({ kind: "unknown" }), null);
  assert.equal(pairSerialWarning({ kind: "matched", serial: "S211GBBC180304" }), null);
  const warning = pairSerialWarning({ kind: "mismatched", left: "S211GBBC180304", right: "S201GCBC300403" });
  assert.ok(warning.includes("S211GBBC180304"));
  assert.ok(warning.includes("S201GCBC300403"));
  // Different frame AND finish — say so, because the wearer can see that difference.
  assert.ok(warning.includes("Even G2 B · Brown"));
  assert.ok(warning.includes("Even G2 A · Green"));
});
