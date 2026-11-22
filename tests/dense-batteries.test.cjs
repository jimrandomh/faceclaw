const test = require('node:test');
const assert = require('node:assert/strict');
const { GrayImage } = require('../.test-build/app/graphics/image.js');
const {
  BATTERY_ICON_WIDTH,
  DENSE_BATTERY_BLOCK_HEIGHT,
  drawBattery,
  drawDenseBatteries,
} = require('../.test-build/app/graphics/battery.js');

const RIGHT = 120;
const TOP = 4;
const LOWER_ROW = DENSE_BATTERY_BLOCK_HEIGHT - drawBattery(0, false).height;

/** Every top-left position where exactly this gauge was drawn. The block is deferred draws: bake them to look. */
function findGauges(drawn, percent, charging) {
  const image = drawn.withDrawsBaked();
  const gauge = drawBattery(percent, charging);
  const found = [];
  for (let y = 0; y + gauge.height <= image.height; y++) {
    for (let x = 0; x + gauge.width <= image.width; x++) {
      let match = true;
      for (let gy = 0; match && gy < gauge.height; gy++) {
        for (let gx = 0; match && gx < gauge.width; gx++) {
          match = image.pixels[(y + gy) * image.width + x + gx] === gauge.pixels[gy * gauge.width + gx];
        }
      }
      if (match) found.push({ x, y });
    }
  }
  return found;
}

function hasInk(drawn, x0, x1, y0, y1) {
  const image = drawn.withDrawsBaked();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (image.pixels[y * image.width + x] > 0) return true;
    }
  }
  return false;
}

function gaugeAt(image, percent, charging = false) {
  const found = findGauges(image, percent, charging);
  assert.equal(found.length, 1, `one ${percent}% gauge`);
  return found[0];
}

test('dense batteries stack two per column, right-aligned', () => {
  const image = new GrayImage(RIGHT + 8, 32, 0);
  const left = drawDenseBatteries(image, [
    { device: 'phone', percent: 80, charging: false },
    { device: 'watch', percent: 35, charging: true },
    { device: 'glasses', percent: 60, charging: false },
    { device: 'ring', percent: 100, charging: false },
  ], RIGHT, TOP);
  const phone = gaugeAt(image, 80);
  const watch = gaugeAt(image, 35, true);
  const glasses = gaugeAt(image, 60);
  const ring = gaugeAt(image, 100);
  assert.deepEqual(glasses, { x: RIGHT - BATTERY_ICON_WIDTH, y: TOP });
  assert.deepEqual(ring, { x: RIGHT - BATTERY_ICON_WIDTH, y: TOP + LOWER_ROW });
  assert.equal(phone.y, TOP);
  assert.deepEqual(watch, { x: phone.x, y: TOP + LOWER_ROW });
  // Each gauge has its device icon to its left.
  assert.ok(hasInk(image, left, phone.x, TOP, TOP + 10));
  assert.ok(hasInk(image, left, watch.x, TOP + LOWER_ROW, TOP + LOWER_ROW + 10));
  assert.ok(hasInk(image, phone.x + BATTERY_ICON_WIDTH, glasses.x, TOP, TOP + 10));
  assert.ok(hasInk(image, watch.x + BATTERY_ICON_WIDTH, ring.x, TOP + LOWER_ROW, TOP + LOWER_ROW + 10));
});

test('an odd count leaves the first indicator alone, vertically centered', () => {
  const image = new GrayImage(RIGHT + 8, 32, 0);
  drawDenseBatteries(image, [
    { device: 'phone', percent: 80, charging: false },
    { device: 'glasses', percent: 60, charging: false },
    { device: 'ring', percent: 20, charging: false },
  ], RIGHT, TOP);
  assert.equal(gaugeAt(image, 80).y, TOP + LOWER_ROW / 2);
  assert.deepEqual(gaugeAt(image, 60), { x: RIGHT - BATTERY_ICON_WIDTH, y: TOP });
  assert.deepEqual(gaugeAt(image, 20), { x: RIGHT - BATTERY_ICON_WIDTH, y: TOP + LOWER_ROW });
});

test('no indicators draws nothing', () => {
  const image = new GrayImage(RIGHT + 8, 32, 0);
  assert.equal(drawDenseBatteries(image, [], RIGHT, TOP), RIGHT);
  assert.ok(image.pixels.every((value) => value === 0));
  assert.equal(image.draws.length, 0);
});

test('icons and gauges are deferred draws of the same images each time, so the glasses can cache them', () => {
  const items = [
    { device: 'phone', percent: 80, charging: false },
    { device: 'glasses', percent: 80, charging: false },
    { device: 'ring', percent: 35, charging: true },
  ];
  const first = new GrayImage(RIGHT + 8, 32, 0), second = new GrayImage(RIGHT + 8, 32, 0);
  drawDenseBatteries(first, items, RIGHT, TOP);
  drawDenseBatteries(second, items, RIGHT, TOP);
  // Nothing goes into the pixels: an icon and a gauge per device, as images.
  assert.ok(first.pixels.every((value) => value === 0));
  assert.equal(first.draws.length, 6);
  assert.ok(first.draws.every((draw) => draw.kind === 'image' && !draw.presentation));
  assert.deepEqual(first.draws.map((draw) => [draw.x, draw.y]), second.draws.map((draw) => [draw.x, draw.y]));
  first.draws.forEach((draw, index) => assert.equal(draw.source, second.draws[index].source));
  // One picture per level and bolt: equal levels share it, and a gauge is never repainted.
  assert.equal(drawBattery(80, false), drawBattery(80, false));
  assert.equal(drawBattery(80, false), drawBattery(79.6, false));
  assert.notEqual(drawBattery(80, false), drawBattery(80, true));
  assert.notEqual(drawBattery(35, true), drawBattery(80, true));
  const gauge = drawBattery(35, true), before = Array.from(gauge.pixels);
  drawBattery(60, true);
  assert.deepEqual(Array.from(gauge.pixels), before);
  // Baked, a deferred gauge is the picture the old pixel copy made.
  const blitted = new GrayImage(40, 16, 0);
  blitted.bitBlt(gauge, 3, 2, { transparentZero: true });
  const deferred = new GrayImage(40, 16, 0);
  deferred.drawImage(gauge, 3, 2);
  assert.deepEqual(Array.from(deferred.withDrawsBaked().pixels), Array.from(blitted.pixels));
});
