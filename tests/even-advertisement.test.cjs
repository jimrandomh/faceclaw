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

// RayNeo iO-2229 as captured 2026-11-01: company 0x5716 + [07][MAC]; pairing mode omits the data.
test("RayNeo iO advertisements classify as one device with its MAC", () => {
  const io = classifyAdvertisement(raw({
    address: "00:6A:5E:5F:33:C2",
    name: "RayNeo iO-2229",
    manufacturerData: "1657" + "07006a5e5f33c2130000000000000001",
  }));
  assert.equal(io.role, "rayneo-io");
  assert.equal(io.embeddedMac, "00:6A:5E:5F:33:C2");
  assert.equal(io.embeddedMacMismatch, false);
  assert.equal(io.serial, null);
  const pairing = classifyAdvertisement(raw({ address: "00:6A:5E:5F:33:C2", name: "RayNeo iO-2229", manufacturerData: "" }));
  assert.equal(pairing.role, "rayneo-io");
  assert.equal(pairing.embeddedMac, null);
  // G2 advertisements are untouched
  assert.equal(classifyAdvertisement(raw({})).role, "left");
});

// ---------------------------------------------------------------------------
// Even G1
// ---------------------------------------------------------------------------

const g1Ascii = (text) => Array.from(text).map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
const g1Raw = (name, manufacturerData, address = "F4:27:E9:CA:E8:3F") => ({
  address,
  name,
  manufacturerData,
  rssi: -50,
  txPower: null,
  connectable: true,
  bonded: false,
  source: "scan",
  seenAtMs: 1000,
});

test("a G1 arm on Even's firmware: side from the name, serial after the side byte", () => {
  const ad = classifyAdvertisement(g1Raw("Even G1_70_L_EF50E5", "02" + g1Ascii("S110LABC030139") + "0000000000"));
  assert.equal(ad.role, "left");
  assert.equal(ad.g1Firmware, "stock");
  assert.equal(ad.serial, "S110LABC030139");
  assert.equal(ad.embeddedMac, null);
});

test("a G1 arm on g1v0: the name says all, the serial is in the 0xFFFF record", () => {
  const ad = classifyAdvertisement(g1Raw("G1v0_R", "ffff" + "01" + "04" + g1Ascii("S110LABC030139")));
  assert.equal(ad.role, "right");
  assert.equal(ad.g1Firmware, "g1v0");
  assert.equal(ad.serial, "S110LABC030139");
  assert.equal(classifyAdvertisement(g1Raw("G1v0S_L", "")).g1Firmware, "g1v0-safe");
  assert.equal(classifyAdvertisement(g1Raw("G1v0S_L", "")).serial, null);
});

const g1Record = (flags, version, serial = "S110LABC030139") => "ffff" + "02" + flags + version + g1Ascii(serial);

test("a G1 arm on g1v0 0.5.66+: its name tells pairs apart, its record says what it runs", () => {
  const ad = classifyAdvertisement(g1Raw("G1CFW_L_EF50E5", g1Record("05", "000542")));
  assert.equal(ad.role, "left");
  assert.equal(ad.g1Firmware, "g1v0");
  assert.equal(ad.g1Version, "0.5.66");
  assert.equal(ad.serial, "S110LABC030139");
  assert.equal(classifyAdvertisement(g1Raw("G1CFW_R_CBE689", g1Record("04", "000542"))).role, "right");
});

test("a G1 arm in safe mode says so in its record, not its name", () => {
  const ad = classifyAdvertisement(g1Raw("G1CFW_L_EF50E5", g1Record("0d", "000542")));
  assert.equal(ad.g1Firmware, "g1v0-safe");
  assert.equal(ad.g1Version, "0.5.66");
});

test("a G1 arm whose record hasn't arrived yet still shows, without a version or serial", () => {
  const ad = classifyAdvertisement(g1Raw("G1CFW_L_EF50E5", ""));
  assert.equal(ad.g1Firmware, "g1v0");
  assert.equal(ad.g1Version, undefined);
  assert.equal(ad.serial, null);
});

test("g1v0 before 0.5.66 and Even's firmware advertise no version", () => {
  assert.equal(classifyAdvertisement(g1Raw("G1v0_R", "ffff" + "01" + "04" + g1Ascii("S110LABC030139"))).g1Version, undefined);
  assert.equal(classifyAdvertisement(g1Raw("Even G1_70_L_EF50E5", "02" + g1Ascii("S110LABC030139"))).g1Version, undefined);
});

test("a G1 pair joins on its serial across firmware, so an install in progress stays one pair", () => {
  const stock = classifyAdvertisement(g1Raw("Even G1_70_L_EF50E5", "02" + g1Ascii("S110LABC030139") + "0000000000"));
  const custom = classifyAdvertisement(g1Raw("G1CFW_R_CBE689", g1Record("04", "000542")));
  assert.equal(stock.serial, custom.serial);
});

test("on iOS a G1 arm gets an address from its peripheral identifier, and is found at all", () => {
  const { identifyIosPeripheral, g1IosAddress } = require("../.test-build/app/g2/ios-peripheral-identity.js");
  const identifier = "14b99254-0798-d1a8-3eec-b141bdabfae8";
  assert.equal(g1IosAddress(identifier), "14:B9:92:54:07:98");
  for (const [name, manufacturerData, firmware] of [
    ["G1CFW_L_EF50E5", g1Record("05", "000542"), "g1v0"],
    ["Even G1_70_L_EF50E5", "02" + g1Ascii("S110LABC030139"), "stock"],
    ["G1v0_L", "ffff" + "01" + "05" + g1Ascii("S110LABC030139"), "g1v0"],
  ]) {
    const device = identifyIosPeripheral({ identifier, name, manufacturerData, rssi: -50, connectable: true });
    assert.ok(device, name);
    assert.equal(device.address, "14:B9:92:54:07:98", name);
    assert.equal(device.identifier, identifier.toUpperCase(), name);
    assert.equal(device.role, "left", name);
    assert.equal(device.g1Firmware, firmware, name);
    assert.equal(device.serial, "S110LABC030139", name);
  }
  assert.equal(identifyIosPeripheral({ identifier: "not-a-uuid", name: "G1CFW_L_EF50E5", manufacturerData: "", rssi: 0, connectable: true }), null);
});

test("names that only look like a G1 are not admitted", () => {
  for (const name of ["G1v0_X", "G1v0", "G1 Tracker", "Even G1", "Pixel G1v0_L", "G1CFW_L", "G1CFW_X_EF50E5", "G1CFW_L_EF50E", "Pixel G1CFW_L_EF50E5"]) {
    assert.equal(classifyAdvertisement(g1Raw(name, "")), null, name);
  }
});
