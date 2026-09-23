const test = require('node:test');
const assert = require('node:assert/strict');
const { MenuHighlightMotion, MENU_HIGHLIGHT_DURATION_MS } = require('../.test-build/app/ui/menu-highlight-motion.js');
const { GrayImage } = require('../.test-build/app/graphics/image.js');
const { encodePresentation, readPresentation, paintPresentation } = require('../.test-build/app/graphics/presentation-wire.js');

test('highlight animates only navigation that preserves the scroll window', () => {
  const motion = new MenuHighlightMotion();
  assert.equal(motion.paint(0, 0, 10, 20, 100, 20, 0), undefined);
  motion.navigate(0, false);
  const moved = motion.paint(1, 0, 10, 40, 100, 20, 100);
  assert.equal(moved.dx, 0);
  assert.equal(moved.dy, -20);
  assert.equal(moved.durationMs, 300);
  assert.equal(motion.paint(1, 0, 10, 40, 100, 20, 250).token, moved.token);
  motion.navigate(1, false);
  const next = motion.paint(2, 0, 10, 60, 100, 20, 250);
  assert.equal(next.dy, -30, 'continue from the halfway position');
  motion.navigate(2, false);
  assert.equal(motion.paint(3, 1, 10, 60, 100, 20, 400), undefined, 'scroll snaps');
  motion.navigate(3, true);
  assert.equal(motion.paint(0, 0, 10, 20, 100, 20, 500), undefined, 'wrap snaps');
  motion.navigate(0, false);
  motion.paint(1, 0, 10, 40, 100, 20, 600);
  assert.ok(motion.paint(1, 0, 10, 40, 100, 20, 899));
  assert.equal(motion.paint(1, 0, 10, 40, 100, 20, 900), undefined, 'finished after 300 ms');
  assert.equal(motion.paint(2, 0, 10, 60, 100, 20, 1200), undefined, 'programmatic changes snap');
});

test('bridge and fallback preview use the supplied animation duration', () => {
  const now = Date.now;
  Date.now = () => 1050;
  try {
    const image = new GrayImage(8, 2);
    image.drawMenuSelection(new GrayImage(2, 2), 5, 0, 0, 255, 0, 0,
      { dx: -4, dy: 0, startedAt: 1000, token: 1, durationMs: 100 });
    const record = readPresentation(encodePresentation(image.draws[0]), 0);
    assert.equal(record.selection.animation.durationMs, 100);
    const screen = new Uint8Array(16), output = new Uint8Array(16);
    paintPresentation(output, screen, 8, 2, record.selection);
    assert.equal(output[3], 240, 'halfway at 50 ms');
    assert.equal(output[1], 0);
    Date.now = () => 1100;
    output.fill(0);
    paintPresentation(output, screen, 8, 2, record.selection);
    assert.equal(output[5], 240, 'complete at 100 ms');
    assert.equal(output[3], 0);
  } finally { Date.now = now; }
});

test('animated selection bridge carries relative start, elapsed time and stable token', () => {
  const now = Date.now;
  Date.now = () => 1200;
  try {
    const image = new GrayImage(8, 4);
    image.drawMenuSelection(new GrayImage(2, 2, 255), 3, 2, 16, 48, 1, 2,
      { dx: -2, dy: -4, startedAt: 1000, token: 42, durationMs: MENU_HIGHLIGHT_DURATION_MS });
    const bytes = encodePresentation(image.draws[0]);
    assert.equal(bytes[0], 6);
    assert.equal(bytes.length, 32);
    const record = readPresentation(bytes, 0);
    assert.equal(record.end, bytes.length);
    assert.deepEqual(record.selection.animation, { dx: -2, dy: -4, startedAt: 1000, token: 42, durationMs: MENU_HIGHLIGHT_DURATION_MS });
    assert.equal(record.selection.x, 3);
    assert.equal(record.selection.y, 2);
  } finally { Date.now = now; }
});
