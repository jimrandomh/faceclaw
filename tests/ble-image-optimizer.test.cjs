const test = require('node:test');
const assert = require('node:assert/strict');
const { deflate } = require('pako');
const { buildBoundingBoxPayload: bbox } = require('../.test-build/app/g2/ble-image-optimizer.js');
const { applyDisplayPayload } = require('./helpers/display-payload.cjs');
const { rle4 } = require('../.test-build/app/g2/ble-protocol.js');

test('mode-3 payload matches the production Android encoder byte for byte', () => {
  // Generated with javac from g2protocol/BleImageOptimizer.java, 2026-09-08.
  const vectors = [
    [0, 0, 0xab, '03000001013412789c93924e000000e70096'],
    [319, 479, 0x12, '039fef01013412789c4b1014020001570084'],
    [3, 5, 0xa5, '03010201013412789c4b90120500016c0090'],
  ];
  for (const [x, y, value, expected] of vectors) {
    const base = new Uint8Array(320 * 480), next = base.slice(); next[y * 320 + x] = value;
    const payload = bbox(base, next, 640, 480, 0x1234, deflate);
    assert.equal(Buffer.from(payload).toString('hex'), expected);
    assert.deepEqual(applyDisplayPayload(base, payload), next);
  }
});

test('bounding boxes include both nibbles, preserve neighboring pixels and cover all four screen edges', () => {
  const base = Uint8Array.from({ length: 320 * 480 }, (_, i) => i & 255);
  for (const x of [0, 1, 2, 3, 4, 637, 638, 639]) for (const y of [0, 1, 2, 477, 478, 479]) {
    const next = base.slice(); next[y * 320 + (x >> 1)] ^= x % 2 ? 15 : 240;
    const payload = bbox(base, next, 640, 480, 1, deflate);
    assert.deepEqual([...payload.slice(1, 5)], [Math.floor(x / 4), Math.floor(y / 2), 1, 1]);
    assert.deepEqual(applyDisplayPayload(base, payload), next);
  }
});

test('unchanged, incompatible and full-screen boxes fall back without compressing a region', () => {
  const base = new Uint8Array(320 * 480), next = base.slice(); next[0] = next[next.length - 1] = 255;
  const compress = () => assert.fail('A fallback must not compress a bounding box');
  assert.equal(bbox(base, base, 640, 480, 1, compress), null);
  assert.equal(bbox(base, next, 640, 480, 1, compress), null);
  assert.equal(bbox(null, next, 640, 480, 1, compress), null);
  assert.equal(bbox(base.subarray(1), next, 640, 480, 1, compress), null);
  assert.equal(bbox(base, next.subarray(1), 640, 480, 1, compress), null);
  for (const [w, h] of [[0, 480], [639, 480], [640, 479], [1024, 480], [640, 512]])
    assert.equal(bbox(base, next, w, h, 1, compress), null);
});

test('seeded sparse edits reconstruct exactly across successive bounding-box updates', () => {
  let seed = 42;
  const random = limit => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
  let base = Uint8Array.from({ length: 320 * 480 }, () => random(256));
  for (let fid = 1; fid <= 60; fid++) {
    const next = base.slice(), bx = random(280), by = random(440);
    for (let n = 0; n < 20; n++) next[(by + random(40)) * 320 + bx + random(40)] ^= 0xff;
    const payload = bbox(base, next, 640, 480, fid, deflate);
    assert.ok(payload); assert.equal(payload[5] | (payload[6] << 8), fid);
    assert.deepEqual(applyDisplayPayload(base, payload), next);
    base = next;
  }
});

test('a small edit compresses only its region and reduces bytes on a busy screen', () => {
  const base = Uint8Array.from({ length: 320 * 480 }, (_, i) => i & 255), next = base.slice();
  next[100 * 320 + 100] ^= 255;
  let compressedInputBytes = 0;
  const payload = bbox(base, next, 640, 480, 1, bytes => { compressedInputBytes += bytes.length; return deflate(bytes); });
  assert.ok(compressedInputBytes <= 8); // A 4x2 rectangle, at most one RLE byte per pixel.
  assert.ok(payload.length < (1 + deflate(rle4(next)).length) / 10);
  assert.deepEqual(applyDisplayPayload(base, payload), next);
});
