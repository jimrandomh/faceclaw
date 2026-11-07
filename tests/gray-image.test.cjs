const test = require('node:test');
const assert = require('node:assert/strict');
const { GrayImage } = require('../.test-build/app/graphics/image.js');

test('a non-integer size rounds up, warns, and leaves every pixel addressable', t => {
  const warn = t.mock.method(console, 'warn', () => {});
  const image = new GrayImage(78.625, 23.5, 7);
  assert.deepEqual([image.width, image.height, image.pixels.length], [79, 24, 79 * 24]);
  assert.ok(image.pixels.every(value => value === 7));
  for (let y = 0; y < image.height; y++) {
    image.setPixel(78, y, 200);
    assert.equal(image.getPixel(78, y), 200, `row ${y}`);
  }
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /78\.625x23\.5/);
});

test('a whole-number size is kept as given, without a warning', t => {
  const warn = t.mock.method(console, 'warn', () => {});
  const image = new GrayImage(79, 24);
  assert.deepEqual([image.width, image.height], [79, 24]);
  assert.equal(warn.mock.callCount(), 0);
});
