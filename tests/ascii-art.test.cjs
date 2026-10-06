const test = require('node:test');
const assert = require('node:assert/strict');
const { imageFromAsciiArt } = require('../.test-build/app/graphics/image.js');

test('imageFromAsciiArt maps characters through the palette', () => {
  const image = imageFromAsciiArt(['#/.', ' _#'], { '#': 255, '/': 128, '_': 64 });
  assert.equal(image.width, 3);
  assert.equal(image.height, 2);
  assert.deepEqual([...image.pixels], [255, 128, 0, 0, 64, 255]);
});

test('imageFromAsciiArt pads short lines and lets the palette override the background', () => {
  const image = imageFromAsciiArt(['.#', '.'], { '#': 300, '.': 10 });
  assert.deepEqual([...image.pixels], [10, 255, 10, 0]);
});

test('imageFromAsciiArt rejects characters missing from the palette', () => {
  assert.throws(() => imageFromAsciiArt(['#x'], { '#': 255 }), /"x"/);
});
