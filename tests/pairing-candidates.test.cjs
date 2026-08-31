// Left↔right pair grouping on the advertised serial, closest-first ordering,
// the "Closest"/"Yours" disambiguators, and the row presentation.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { bytesToHex } = require("../.test-build/app/g2/even-advertisement.js");
const {
  DiscoveryAggregator,
  nearestCandidateId,
  isPreviouslyPaired,
  glassesRow,
  ringRow,
  DEFAULT_STALE_AFTER_MS,
} = require("../.test-build/app/g2/pairing-candidates.js");
const { requiredArtworkFileNames, glassesImagePath, GENERIC_G2_IMAGE_PATH } = require("../.test-build/app/g2/glasses-artwork.js");
const { GlassesHardwareIdentity } = require("../.test-build/app/g2/glasses-hardware-identity.js");

const ascii = (s) => bytesToHex(Array.from(s).map((c) => c.charCodeAt(0)));
const wireOf = (human) => bytesToHex(human.split(":").map((h) => parseInt(h, 16)).reverse());

function arm(side, serial, address, rssi, extra = {}) {
  const tail = address.replace(/:/g, "").slice(-6);
  return {
    address,
    name: `Even G2_32_${side === "left" ? "L" : "R"}_${tail}`,
    manufacturerData: "4552" + ascii(serial) + wireOf(address) + "01",
    rssi,
    txPower: null,
    connectable: true,
    bonded: false,
    source: "scan",
    seenAtMs: 1000,
    ...extra,
  };
}

function ring(address, rssi, extra = {}) {
  const tail = address.replace(/:/g, "").slice(-6);
  return {
    address,
    name: `EVEN R1_${tail}`,
    manufacturerData: "4552" + wireOf(address) + ascii("140137"),
    rssi,
    txPower: null,
    connectable: true,
    bonded: false,
    source: "scan",
    seenAtMs: 1000,
    ...extra,
  };
}

// One real pair: the left and right arms carry DIFFERENT name tails (per-arm
// address) but the SAME serial. That serial is the pair identity.
const LEFT = arm("left", "S211GBBC180304", "E0:12:14:AC:D4:58", -50);
const RIGHT = arm("right", "S211GBBC180304", "E0:12:14:8D:6E:3C", -54);
const OTHER_RIGHT = arm("right", "S211GCBC300403", "E0:12:14:14:12:E0", -80);

test("left and right arms advertising the same serial group into one complete pair", () => {
  const aggregator = new DiscoveryAggregator();
  aggregator.ingest(LEFT);
  aggregator.ingest(RIGHT);
  const pairs = aggregator.pairs();
  assert.equal(pairs.length, 1);
  const pair = pairs[0];
  assert.equal(pair.id, "S211GBBC180304");
  assert.equal(pair.completeness, "complete");
  assert.equal(pair.left.address, "E0:12:14:AC:D4:58");
  assert.equal(pair.right.address, "E0:12:14:8D:6E:3C");
  assert.equal(pair.identity.displayName, "Even G2 B · Brown");
  // Strongest arm's signal represents the pair.
  assert.equal(pair.rssi, -50);
  assert.ok(pair.proximity);
});

test("arms with different serials are different pairs, each incomplete", () => {
  const aggregator = new DiscoveryAggregator();
  aggregator.ingest(LEFT);
  aggregator.ingest(OTHER_RIGHT);
  const pairs = aggregator.pairs();
  assert.equal(pairs.length, 2);
  assert.deepEqual(
    pairs.map((p) => [p.id, p.completeness]),
    [
      ["S211GBBC180304", "left-only"],
      ["S211GCBC300403", "right-only"],
    ],
  );
});

test("pairs sort closest first; a pair without a signal sorts last", () => {
  const aggregator = new DiscoveryAggregator();
  aggregator.ingest(arm("left", "S211GAAA000001", "00:00:00:00:00:01", -80));
  aggregator.ingest(arm("left", "S211GAAA000002", "00:00:00:00:00:02", -40));
  aggregator.ingest(arm("left", "S211GAAA000003", "00:00:00:00:00:03", null));
  assert.deepEqual(
    aggregator.pairs().map((p) => p.id),
    ["S211GAAA000002", "S211GAAA000001", "S211GAAA000003"],
  );
});

test("an arm without a serial stands alone keyed by its address", () => {
  const aggregator = new DiscoveryAggregator();
  aggregator.ingest({ ...LEFT, manufacturerData: "" });
  const pairs = aggregator.pairs();
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].id, "arm:E0:12:14:AC:D4:58");
  assert.equal(pairs[0].serial, null);
  const row = glassesRow(pairs[0]);
  assert.equal(row.canSelect, false);
  assert.match(row.armsSummary, /serial unknown/);
});

test("a bonded listing never erases a scanned serial and gains one when heard", () => {
  const aggregator = new DiscoveryAggregator();
  aggregator.ingest({ ...LEFT, manufacturerData: "", rssi: null, bonded: true, source: "paired" });
  assert.equal(aggregator.pairs()[0].serial, null);
  aggregator.ingest({ ...LEFT, seenAtMs: 2000 });
  assert.equal(aggregator.pairs()[0].serial, "S211GBBC180304");
  assert.equal(aggregator.pairs()[0].left.bonded, true);
  aggregator.ingest({ ...LEFT, manufacturerData: "", rssi: null, bonded: true, source: "paired", seenAtMs: 3000 });
  assert.equal(aggregator.pairs()[0].serial, "S211GBBC180304");
});

test("stale advertisements are pruned; bonded entries survive", () => {
  const aggregator = new DiscoveryAggregator();
  aggregator.ingest(LEFT);
  aggregator.ingest({ ...RIGHT, bonded: true });
  aggregator.prune(1000 + DEFAULT_STALE_AFTER_MS + 1);
  const pairs = aggregator.pairs();
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].completeness, "right-only");
});

test("RSSI is smoothed across repeated advertisements", () => {
  const aggregator = new DiscoveryAggregator();
  aggregator.ingest({ ...LEFT, rssi: -40 });
  aggregator.ingest({ ...LEFT, rssi: -80, seenAtMs: 1100 });
  const rssi = aggregator.pairs()[0].rssi;
  assert.ok(rssi < -40 && rssi > -80, `expected a blend, got ${rssi}`);
});

test("rings are grouped separately and sorted closest first", () => {
  const aggregator = new DiscoveryAggregator();
  aggregator.ingest(LEFT);
  aggregator.ingest(ring("DA:7F:D2:B5:6E:E2", -70));
  aggregator.ingest(ring("DA:7F:D2:00:00:01", -45));
  assert.equal(aggregator.pairs().length, 1);
  assert.deepEqual(
    aggregator.rings().map((r) => r.id),
    ["DA:7F:D2:00:00:01", "DA:7F:D2:B5:6E:E2"],
  );
  const row = ringRow(aggregator.rings()[1]);
  assert.equal(row.modelTitle, "Even R1");
  assert.match(row.deviceName, /140137/);
  assert.equal(aggregator.rings()[1].advertisement.address, "DA:7F:D2:B5:6E:E2");
});

test("nearest requires a clear signal lead", () => {
  const d = (id, rssi) => ({ id, rssi });
  assert.equal(nearestCandidateId([d("1", -40), d("2", -70)]), "1");
  assert.equal(nearestCandidateId([d("1", -60), d("2", -57)]), null);
  // A lone advertiser has nothing to be closer than, so no Closest badge.
  assert.equal(nearestCandidateId([d("1", -80)]), null);
  // Nothing to rank without RSSI.
  assert.equal(nearestCandidateId([d("1", null)]), null);
  assert.equal(nearestCandidateId([]), null);
});

test("previously paired matches across the arm suffix", () => {
  assert.ok(isPreviouslyPaired("S211GBBC180304", "S211GBBC180304_L_1"));
  assert.ok(!isPreviouslyPaired("S211GBBC180304", "S211GCBC300403"));
  assert.ok(!isPreviouslyPaired("S211GBBC180304", ""));
  assert.ok(!isPreviouslyPaired("S211GBBC180304", null));
  assert.ok(!isPreviouslyPaired(null, "S211GBBC180304"));
});

test("scan row carries the decoded variant, artwork, and proximity", () => {
  const aggregator = new DiscoveryAggregator();
  aggregator.ingest({ ...LEFT, rssi: -42 });
  aggregator.ingest({ ...RIGHT, rssi: -42 });
  const row = glassesRow(aggregator.pairs()[0]);
  assert.equal(row.modelTitle, "Even G2 B");
  assert.equal(row.deviceName, "S211GBBC180304");
  assert.equal(row.variantSummary, "Frame B · Brown");
  assert.equal(row.colorway, "brown");
  assert.equal(row.imagePath, "~/images/glasses/glasses_g2_b_brown.png");
  assert.equal(row.hasVariantImage, true);
  assert.match(row.proximitySummary, /In your hand|Nearby/);
  assert.match(row.armsSummary, /serials match/);
  assert.equal(row.canSelect, true);
  assert.equal(row.isNearest, false);
  assert.equal(row.badge, "");
});

test("the Yours badge wins over Closest; Closest needs the nearest id", () => {
  const aggregator = new DiscoveryAggregator();
  aggregator.ingest(LEFT);
  aggregator.ingest(RIGHT);
  const pair = aggregator.pairs()[0];
  assert.equal(glassesRow(pair, { nearestId: pair.id }).badge, "Closest");
  assert.equal(glassesRow(pair, { nearestId: pair.id, pairedSerial: "S211GBBC180304_L_1" }).badge, "Yours");
});

test("a pair whose serial does not decode falls back to the generic shot and swatch-less row", () => {
  const aggregator = new DiscoveryAggregator();
  aggregator.ingest(arm("left", "XX11GBBC180304", "00:00:00:00:00:01", -50));
  aggregator.ingest(arm("right", "XX11GBBC180304", "00:00:00:00:00:02", -50));
  const row = glassesRow(aggregator.pairs()[0]);
  assert.equal(row.modelTitle, "Even Realities G2");
  assert.equal(row.variantSummary, null);
  assert.equal(row.swatchHex, null);
  assert.equal(row.imagePath, GENERIC_G2_IMAGE_PATH);
  assert.equal(row.hasVariantImage, false);
  assert.equal(row.canSelect, true);
});

test("frame C resolves to the generic shot with the swatch still available", () => {
  const identity = GlassesHardwareIdentity.decode("S221GCAA000001");
  assert.equal(glassesImagePath(identity), GENERIC_G2_IMAGE_PATH);
  assert.equal(identity.colorway, "green");
});

test("an incomplete pair cannot be selected and says which arm is missing", () => {
  const aggregator = new DiscoveryAggregator();
  aggregator.ingest(RIGHT);
  const pair = aggregator.pairs()[0];
  const row = glassesRow(pair);
  assert.equal(row.canSelect, false);
  assert.match(row.armsSummary, /Only the right arm/);
  assert.equal(pair.right.address, "E0:12:14:8D:6E:3C");
  assert.equal(pair.left, null);
});

test("a lone left and lone right with different serials warn about mixed arms", () => {
  const aggregator = new DiscoveryAggregator();
  aggregator.ingest(LEFT);
  aggregator.ingest(OTHER_RIGHT);
  for (const pair of aggregator.pairs()) {
    const row = glassesRow(pair);
    assert.match(row.warning, /arms from two different pairs/);
    assert.match(row.warning, /S211GBBC180304/);
    assert.match(row.warning, /S211GCBC300403/);
    assert.equal(row.canSelect, false);
  }
});

test("a bonded re-emit does not overwrite live scan notes or name", () => {
  const aggregator = new DiscoveryAggregator();
  aggregator.ingest(LEFT);
  // Every pairing-page re-entry replays bonded devices: no manufacturer data,
  // possibly stale cached name. That must not turn a fully-parsed row into
  // "serial unknown" or swap in the stale name.
  aggregator.ingest({ ...LEFT, name: "Even G2_32_L_0LDCAF", manufacturerData: "", rssi: null, bonded: true, source: "paired", seenAtMs: 2000 });
  const pair = aggregator.pairs()[0];
  assert.equal(pair.serial, "S211GBBC180304");
  assert.equal(pair.left.name, LEFT.name);
  assert.equal(pair.left.note, null);
  assert.equal(glassesRow(pair).warning, "");
});

test("a split report without the name keeps the arm by merging earlier traffic", () => {
  const aggregator = new DiscoveryAggregator();
  aggregator.ingest(LEFT);
  // Android sometimes delivers the ADV report (manufacturer data, no name)
  // separately from the scan response carrying the name.
  const merged = aggregator.ingest({ ...LEFT, name: "", seenAtMs: 2000 });
  assert.ok(merged, "the nameless half must not drop the arm");
  assert.equal(merged.role, "left");
  const pair = aggregator.pairs()[0];
  assert.equal(pair.completeness, "left-only");
  assert.equal(pair.left.name, LEFT.name);
  assert.equal(pair.left.seenAtMs, 2000);
});

test("an embedded-MAC mismatch is surfaced as a warning", () => {
  const aggregator = new DiscoveryAggregator();
  aggregator.ingest({ ...LEFT, address: "AA:BB:CC:DD:EE:FF" });
  aggregator.ingest(RIGHT);
  const row = glassesRow(aggregator.pairs()[0]);
  assert.match(row.warning, /Left arm's advertised address/);
});

test("every artwork file the resolver claims is bundled exists on disk", () => {
  const dir = path.join(__dirname, "..", "app", "images", "glasses");
  for (const name of requiredArtworkFileNames()) {
    assert.ok(fs.existsSync(path.join(dir, name)), `missing app/images/glasses/${name}`);
  }
});
