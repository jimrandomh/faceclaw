// Advertisement parsers, checked against layouts confirmed by
// HCI capture (G2: "ER"+SN(14)+MAC(6,LE)+flag) and on-disk forensics (R1:
// "ER"+MAC(6,wire)+ASCII serial suffix on ring firmware 2.2.7.x).
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  hexToBytes,
  bytesToHex,
  hasEvenManufacturerSignature,
  extractG2Serial,
  extractG2Mac,
  extractG2AdvertisementFlag,
  g2SideFromName,
  g2NameAddressTail,
  wireBytesFromHumanReadableAddress,
  humanReadableAddressFromWireBytes,
  ringNameAddressOctets,
  ringMacWireBytes,
  extractRingSerialSuffix,
  classifyAdvertisement,
  normalizeMacAddress,
  EVEN_COMPANY_IDENTIFIER,
} = require("../.test-build/app/g2/even-advertisement.js");

const ascii = (s) => bytesToHex(Array.from(s).map((c) => c.charCodeAt(0)));

// Real pair serial S211GBBC180304 at E0:12:14:B6:EC:E0 (HCI capture 2026-04-12).
const G2_MFG_HEX = "4552" + ascii("S211GBBC180304") + "E0ECB61412E0" + "01";

// Ring identity proven on disk: wire E2 6E B5 D2 7F DA ⇄ human DA:7F:D2:B5:6E:E2,
// name suffix B56EE2 = human last three octets, followed by ASCII serial "140137".
const RING_MFG_HEX = "4552" + "E26EB5D27FDA" + ascii("140137");

const raw = (overrides) => ({
  address: "E0:12:14:B6:EC:E0",
  name: "Even G2_32_L_B6ECE0",
  manufacturerData: G2_MFG_HEX,
  rssi: -55,
  txPower: null,
  connectable: true,
  bonded: false,
  source: "scan",
  seenAtMs: 1000,
  ...overrides,
});

test("company identifier is the ASCII bytes ER read little-endian", () => {
  assert.equal(EVEN_COMPANY_IDENTIFIER, 0x5245);
  assert.ok(hasEvenManufacturerSignature(hexToBytes("4552")));
  assert.ok(!hasEvenManufacturerSignature(hexToBytes("5245")));
});

test("G2 manufacturer data yields serial, MAC, and flag", () => {
  const mfg = hexToBytes(G2_MFG_HEX);
  assert.equal(mfg.length, 23);
  assert.equal(extractG2Serial(mfg), "S211GBBC180304");
  assert.equal(extractG2Mac(mfg), "E0:12:14:B6:EC:E0");
  assert.equal(extractG2AdvertisementFlag(mfg), 1);
});

test("short or binary manufacturer data yields no serial", () => {
  assert.equal(extractG2Serial(hexToBytes("4552")), null);
  assert.equal(extractG2Serial(hexToBytes("4552" + "FF".repeat(14))), null);
  assert.equal(extractG2Mac(hexToBytes("4552" + ascii("S211GBBC180304"))), null);
  assert.equal(extractG2AdvertisementFlag(hexToBytes(G2_MFG_HEX.slice(0, -2))), null);
});

test("side comes from the local name; the hex tail is per-arm", () => {
  assert.equal(g2SideFromName("Even G2_32_L_ACD458"), "left");
  assert.equal(g2SideFromName("Even G2_32_R_8D6E3C"), "right");
  assert.equal(g2SideFromName("Even G2_32"), null);
  assert.equal(g2SideFromName("X_L_R_"), null);
  assert.equal(g2NameAddressTail("Even G2_32_L_ACD458"), "ACD458");
  assert.equal(g2NameAddressTail("Even G2"), null);
});

test("address codec crosses wire/human order exactly once", () => {
  const wire = wireBytesFromHumanReadableAddress("DA:7F:D2:B5:6E:E2");
  assert.equal(bytesToHex(wire), "E26EB5D27FDA");
  assert.equal(humanReadableAddressFromWireBytes(wire), "DA:7F:D2:B5:6E:E2");
  assert.equal(wireBytesFromHumanReadableAddress("nope"), null);
  assert.equal(normalizeMacAddress("e0ecb61412e0"), "E0:EC:B6:14:12:E0");
});

test("ring name suffix octets parse from the full name and the bare id", () => {
  assert.deepEqual(ringNameAddressOctets("EVEN R1_B56EE2"), [0xb5, 0x6e, 0xe2]);
  assert.deepEqual(ringNameAddressOctets("B56EE2"), [0xb5, 0x6e, 0xe2]);
  assert.equal(ringNameAddressOctets("EVEN R1_B56E"), null);
  assert.equal(ringNameAddressOctets(null), null);
});

test("ring MAC extraction anchors on the marker and rejects the serial suffix", () => {
  const mfg = hexToBytes(RING_MFG_HEX);
  // The historical suffix(6) slice would have returned "140137" as ASCII bytes.
  assert.equal(bytesToHex(mfg.subarray(mfg.length - 6)), "313430313337");
  const wire = ringMacWireBytes(mfg, "EVEN R1_B56EE2");
  assert.equal(bytesToHex(wire), "E26EB5D27FDA");
  assert.equal(humanReadableAddressFromWireBytes(wire), "DA:7F:D2:B5:6E:E2");
  assert.equal(extractRingSerialSuffix(mfg), "140137");
});

test("ring MAC extraction fails closed when the name contradicts every window", () => {
  assert.equal(ringMacWireBytes(hexToBytes(RING_MFG_HEX), "EVEN R1_000000"), null);
  // Without a verifiable name, the documented marker layout wins.
  assert.equal(bytesToHex(ringMacWireBytes(hexToBytes(RING_MFG_HEX), null)), "E26EB5D27FDA");
});

test("classifies a G2 left arm with its serial and embedded MAC", () => {
  const ad = classifyAdvertisement(raw({}));
  assert.equal(ad.role, "left");
  assert.equal(ad.serial, "S211GBBC180304");
  assert.equal(ad.embeddedMac, "E0:12:14:B6:EC:E0");
  assert.equal(ad.embeddedMacMismatch, false);
  assert.equal(ad.flag, 1);
  assert.equal(ad.note, null);
});

test("flags an embedded MAC that disagrees with the radio address", () => {
  const ad = classifyAdvertisement(raw({ address: "AA:BB:CC:DD:EE:FF", name: "Even G2_32_R_DDEEFF" }));
  assert.equal(ad.role, "right");
  assert.equal(ad.embeddedMacMismatch, true);
});

test("renamed firmware is admitted on the ER signature alone", () => {
  const ad = classifyAdvertisement(raw({ name: "Faceclaw_L_1" }));
  assert.ok(ad);
  assert.equal(ad.role, "left");
  assert.equal(ad.serial, "S211GBBC180304");
});

test("a G2 name without manufacturer data is admitted but carries a note", () => {
  const ad = classifyAdvertisement(raw({ manufacturerData: "" }));
  assert.equal(ad.role, "left");
  assert.equal(ad.serial, null);
  assert.match(ad.note, /no manufacturer data/);
  const short = classifyAdvertisement(raw({ manufacturerData: "4552AABB" }));
  assert.match(short.note, /too short/);
});

test("a G2 advertisement with no side marker cannot be placed in a pair", () => {
  assert.equal(classifyAdvertisement(raw({ name: "Even G2_32" })), null);
});

test("classifies the ring from its name and validated MAC", () => {
  const ad = classifyAdvertisement(raw({ address: "DA:7F:D2:B5:6E:E2", name: "EVEN R1_B56EE2", manufacturerData: RING_MFG_HEX }));
  assert.equal(ad.role, "ring");
  assert.equal(ad.serial, null);
  assert.equal(ad.embeddedMac, "DA:7F:D2:B5:6E:E2");
  assert.equal(ad.embeddedMacMismatch, false);
  assert.equal(ad.ringSerialSuffix, "140137");
});

test("ignores unrelated advertisers", () => {
  assert.equal(classifyAdvertisement(raw({ name: "Pixel Buds", manufacturerData: "E000010203" })), null);
  assert.equal(classifyAdvertisement(raw({ name: "", manufacturerData: "" })), null);
});

test("a bare R1 substring is not a ring — only the stock EVEN R1 prefix is", () => {
  assert.equal(classifyAdvertisement(raw({ name: "Oppo Enco R1", manufacturerData: "" })), null);
  assert.equal(classifyAdvertisement(raw({ name: "R1 Speaker", manufacturerData: "" })), null);
  const ad = classifyAdvertisement(raw({ address: "DA:7F:D2:B5:6E:E2", name: "EVEN R1_B56EE2", manufacturerData: "" }));
  assert.equal(ad.role, "ring");
});
