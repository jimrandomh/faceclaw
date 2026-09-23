const test = require('node:test');
const assert = require('node:assert/strict');
const { MenuHighlightMotion } = require('../.test-build/app/ui/menu-highlight-motion.js');
const { GrayImage } = require('../.test-build/app/graphics/image.js');
const { encodePresentation, readPresentation } = require('../.test-build/app/graphics/presentation-wire.js');

test('highlight animates only navigation that preserves the scroll window', () => {
  const motion = new MenuHighlightMotion();
  assert.equal(motion.paint(0, 0, 10, 20, 100, 20, 0), undefined);
  motion.navigate(0, false);
  const moved = motion.paint(1, 0, 10, 40, 100, 20, 100);
  assert.equal(moved.dx, 0);
  assert.equal(moved.dy, -20);
  assert.equal(motion.paint(1, 0, 10, 40, 100, 20, 350).token, moved.token);
  motion.navigate(1, false);
  const next = motion.paint(2, 0, 10, 60, 100, 20, 350);
  assert.equal(next.dy, -30, 'continue from the halfway position');
  motion.navigate(2, false);
  assert.equal(motion.paint(3, 1, 10, 60, 100, 20, 400), undefined, 'scroll snaps');
  motion.navigate(3, true);
  assert.equal(motion.paint(0, 0, 10, 20, 100, 20, 500), undefined, 'wrap snaps');
  motion.navigate(0, false);
  motion.paint(1, 0, 10, 40, 100, 20, 600);
  assert.equal(motion.paint(1, 0, 10, 40, 100, 20, 1100), undefined, 'finished after 500 ms');
  assert.equal(motion.paint(2, 0, 10, 60, 100, 20, 1200), undefined, 'programmatic changes snap');
});

test('animated selection bridge carries relative start, elapsed time and stable token', () => {
  const now = Date.now;
  Date.now = () => 1200;
  try {
    const image = new GrayImage(8, 4);
    image.drawMenuSelection(new GrayImage(2, 2, 255), 3, 2, 16, 48, 1, 2,
      { dx: -2, dy: -4, startedAt: 1000, token: 42 });
    const bytes = encodePresentation(image.draws[0]);
    assert.equal(bytes[0], 6);
    assert.equal(bytes.length, 30);
    const record = readPresentation(bytes, 0);
    assert.equal(record.end, bytes.length);
    assert.deepEqual(record.selection.animation, { dx: -2, dy: -4, startedAt: 1000, token: 42 });
    assert.equal(record.selection.x, 3);
    assert.equal(record.selection.y, 2);
  } finally { Date.now = now; }
});
