const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const { readZipEntry, assembleG1Image, decodeG1OwnBytes, G1FirmwareError } = require('../.test-build/app/g1/firmware-image.js');
const plan = require('../.test-build/app/g1/flash-plan.js');
const { G1V0_IMAGE } = require('../.test-build/app/g1/firmware/g1v0-image.js');
const { G1V0_OWN_BYTES_BASE64 } = require('../.test-build/app/g1/firmware/g1v0-own-bytes.js');

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const noise = (length, seed) => Uint8Array.from({ length }, (_, i) => (i * 31 + seed * 17 + (i >> 3)) & 0xff);
const fromBase64 = (text) => new Uint8Array(Buffer.from(text, 'base64'));

/** A zip the way Even's are made: one entry stored, the others deflated, under a folder. */
function zipOf(entries) {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const { name, data, deflate } of entries) {
    const packed = deflate ? zlib.deflateRawSync(data) : Buffer.from(data);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    directory.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const centralBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, centralBytes, end]));
}

function fixture() {
  const net = noise(5000, 1);
  const app = noise(9000, 2);
  const image = noise(20000, 3);
  const table = app.subarray(4000, 4352);
  image.set(net, 3000);
  image.set(table, 12000);
  const parts = [
    { offset: 3000, length: net.length, file: 'net.bin', fileOffset: 0, sha256: sha(net) },
    { offset: 12000, length: table.length, file: 'app.bin', fileOffset: 4000, sha256: sha(table) },
  ];
  const own = Buffer.concat([image.subarray(0, 3000), image.subarray(8000, 12000), image.subarray(12352)]);
  const manifest = { version: '0.0.1', sha256: sha(image), size: image.length, source: 't', stockVersion: 's', stockZipUrl: 'u', stockZipSha256: 'z', parts };
  return { net, app, image, own: new Uint8Array(own), manifest };
}

test('a zip entry is found, deflated or stored, also under a folder', () => {
  const stored = noise(300, 4);
  const packed = noise(70000, 5);
  const zip = zipOf([{ name: 'manifest.json', data: stored }, { name: 'firmware/app.bin', data: packed, deflate: true }]);
  assert.deepEqual(readZipEntry(zip, 'manifest.json'), stored);
  assert.deepEqual(Buffer.from(readZipEntry(zip, 'app.bin')), Buffer.from(packed));
  assert.throws(() => readZipEntry(zip, 'missing.bin'), /no missing\.bin/);
  assert.throws(() => readZipEntry(noise(100, 6), 'x'), /not a zip/);
});

test('the parts go back where they were, byte for byte', () => {
  const { net, app, image, own, manifest } = fixture();
  const files = { 'net.bin': net, 'app.bin': app };
  const out = assembleG1Image(manifest, own, (name) => files[name], sha);
  assert.deepEqual(Buffer.from(out), Buffer.from(image));
});

test('a part that is not the one it was built with is refused', () => {
  const { net, app, own, manifest } = fixture();
  const bad = net.slice();
  bad[100] ^= 1;
  const files = { 'net.bin': bad, 'app.bin': app };
  assert.throws(() => assembleG1Image(manifest, own, (name) => files[name], sha), G1FirmwareError);
  const short = { 'net.bin': net.subarray(0, 100), 'app.bin': app };
  assert.throws(() => assembleG1Image(manifest, own, (name) => short[name], sha), /not the one/);
});

test('damaged bundled bytes never pass as an image', () => {
  const { net, app, own, manifest } = fixture();
  const files = { 'net.bin': net, 'app.bin': app };
  const flipped = own.slice();
  flipped[10] ^= 1;
  assert.throws(() => assembleG1Image(manifest, flipped, (name) => files[name], sha), /failed verification/);
  assert.throws(() => assembleG1Image(manifest, own.subarray(0, own.length - 1), (name) => files[name], sha), G1FirmwareError);
});

test('the bundled firmware is whole and carries none of Even\'s bytes in its manifest ranges', () => {
  const own = decodeG1OwnBytes(G1V0_OWN_BYTES_BASE64, fromBase64);
  const taken = G1V0_IMAGE.parts.reduce((sum, part) => sum + part.length, 0);
  assert.equal(own.length + taken, G1V0_IMAGE.size);
  // MCUboot's magic and the version in its header, ahead of the first part.
  assert.equal(Buffer.from(own.subarray(0, 4)).toString('hex'), '3db8f396');
  assert.equal(`${own[20]}.${own[21]}.${own[22] | (own[23] << 8)}`, G1V0_IMAGE.version);
  assert.match(G1V0_IMAGE.stockZipUrl, /^https:\/\/cdn\.evenreal\.co\//);
  assert.match(G1V0_IMAGE.sha256, /^[0-9a-f]{64}$/);
  const sorted = [...G1V0_IMAGE.parts].sort((a, b) => a.offset - b.offset);
  assert.ok(sorted[0].offset > 512 && sorted.at(-1).offset + sorted.at(-1).length < G1V0_IMAGE.size);
  assert.doesNotMatch(G1V0_IMAGE.source, /uncommitted/, 'ship only a firmware that was committed');
});

test('versions compare by number, not by text', () => {
  assert.ok(plan.compareG1Versions('0.5.100', '0.5.63') > 0);
  assert.ok(plan.compareG1Versions('0.5.9', '0.5.63') < 0);
  assert.equal(plan.compareG1Versions('0.5.63', '0.5.63'), 0);
  assert.equal(plan.compareG1Versions('0.5', '0.5.0'), 0);
  assert.ok(plan.compareG1Versions('', '0.5.63') < 0);
});

test('a pair is chosen by serial, then address, and never guessed between two', () => {
  const g1 = (serial, left, right) => ({ g1Firmware: 'g1v0', serial, left: left && { address: left }, right: right && { address: right } });
  const ours = g1('S1', 'L1', 'R1');
  const theirs = g1('S2', 'L2', 'R2');
  assert.equal(plan.pickG1Pair([theirs, ours], { serial: 's1' }), ours);
  assert.equal(plan.pickG1Pair([theirs, ours], { left: 'L1' }), ours);
  assert.equal(plan.pickG1Pair([theirs, ours], { right: 'R2' }), theirs);
  assert.equal(plan.pickG1Pair([theirs, ours], {}), null);
  assert.equal(plan.pickG1Pair([ours], {}), ours);
  // A flash changed the addresses: the serial still finds it.
  assert.equal(plan.pickG1Pair([g1('S1', 'NEW', 'NEW2'), theirs], { serial: 'S1', left: 'OLD', right: 'OLD2' }).left.address, 'NEW');
  // Our serial with one arm heard so far: wait, even if another pair is complete.
  assert.equal(plan.pickG1Pair([g1('S1', 'L1', null), theirs], { serial: 'S1' }), null);
  // The wanted glasses weren't heard: another pair is never a stand-in, even the only one around.
  assert.equal(plan.pickG1Pair([theirs], { serial: 'S1' }), null);
  assert.equal(plan.pickG1Pair([theirs], { left: 'L1', right: 'R1' }), null);
  // A wanted address on one side doesn't match a pair for lacking the other.
  assert.equal(plan.pickG1Pair([g1('S2', 'L2', null)], { left: 'L1' }), null);
  // G2 pairs don't count.
  assert.equal(plan.pickG1Pair([{ serial: 'S9', left: { address: 'a' }, right: { address: 'b' } }], {}), null);
});

test('the state of the two arms is that of the arm that needs the most', () => {
  const on = (version, extra = {}) => ({ firmware: 'g1v0', version, safeMode: false, ...extra });
  const state = (...arms) => plan.g1FirmwareState(arms, '0.5.63');
  assert.equal(state(on('0.5.63'), on('0.5.63')), 'current');
  assert.equal(state(on('0.5.64'), on('0.5.63')), 'current');
  assert.equal(state(on('0.5.62'), on('0.5.63')), 'older');
  assert.equal(state(on('0.5.63', { safeMode: true }), on('0.5.62')), 'safe-mode');
  assert.equal(state({ firmware: 'stock' }, on('0.5.63', { safeMode: true })), 'stock');
});

test('the native flow\'s answer is read, and nonsense is no answer', () => {
  assert.deepEqual(plan.parseG1FlashResult('{"flashed":true,"version":"0.5.64"}'), { flashed: true, version: '0.5.64' });
  assert.deepEqual(plan.parseG1FlashResult('nonsense'), {});
  assert.deepEqual(plan.parseG1FlashResult(''), {});
  assert.deepEqual(plan.parseG1FlashResult('null'), {});
});

test('each arm counts for half of the bar', () => {
  assert.equal(plan.g1FlashPercent('left', 0, 100), 0);
  assert.equal(plan.g1FlashPercent('left', 100, 100), 50);
  assert.equal(plan.g1FlashPercent('right', 0, 100), 50);
  assert.equal(plan.g1FlashPercent('right', 100, 100), 100);
  assert.equal(plan.g1FlashPercent('right', 5, 0), 50);
});
