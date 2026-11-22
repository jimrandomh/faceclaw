const test = require('node:test');
const assert = require('node:assert/strict');
const { GrayImage, grayToNibble } = require('../.test-build/app/graphics/image.js');

const font = { fingerprintId: 1, atlasKey: null, ascent: 4, lineHeight: 6 };
/** A 4x1 antialiased glyph whose coverage runs from faint to full. */
const glyph = { encoding: 65, dwidthX: 4, bbxWidth: 4, bbxHeight: 1, bbxX: 0, bbxY: 0, bitmapRows: [],
  coverage: Uint8Array.of(1, 5, 10, 15) };

test('faint antialiased pixels bake as opaque black, not the transparent color key', () => {
  // Opaque black (1) under text drawn at 200 (level 13): coverage 1 maps to level 13/15 = 0.
  const image = new GrayImage(4, 6, 1);
  image.drawGlyph(font, glyph, 0, 0, 200);
  const top = font.ascent - glyph.bbxHeight; // the glyph's row: the baseline minus its height
  const row = Array.from(image.withDrawsBaked().pixels.subarray(top * 4, top * 4 + 4));
  assert.deepEqual(row.map(grayToNibble), [0, 4, 8, 13], 'the levels the firmware draws');
  assert.ok(row.every((v) => v !== 0), 'no pixel of the glyph is a transparent hole');
  // Ink of value 0 still draws transparent, as before.
  const erase = new GrayImage(4, 6, 1);
  erase.drawGlyph(font, glyph, 0, 0, 0);
  assert.deepEqual(Array.from(erase.withDrawsBaked().pixels.subarray(top * 4, top * 4 + 4)), [0, 0, 0, 0]);
});

test('composing an image into another carries each deferred draw once', () => {
  const inner = new GrayImage(10, 10);
  inner.drawGlyph(font, glyph, 1, 1, 255);
  inner.drawImage(new GrayImage(2, 2, 255), 3, 3);
  const middle = new GrayImage(20, 20);
  inner.composeInto(middle, 5, 5);
  const outer = new GrayImage(40, 40);
  middle.composeInto(outer, 2, 2);
  assert.equal(outer.draws.length, 2);
  assert.deepEqual(outer.draws.map((d) => [d.kind, d.x, d.y]), [['glyph', 8, 8], ['image', 10, 10]]);
  // Draws anchored outside the source still come along, unlike bitBlt's.
  const overhang = new GrayImage(4, 4);
  overhang.drawGlyph(font, glyph, -2, 0, 255);
  const target = new GrayImage(8, 8);
  overhang.composeInto(target, 4, 0);
  assert.deepEqual(target.draws.map((d) => d.x), [2]);
});
