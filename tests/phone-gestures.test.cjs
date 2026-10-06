const test = require('node:test');
const assert = require('node:assert/strict');
const { PhoneGestureRecognizer } = require('../.test-build/app/phone-ui/phone-gestures.js');
function setup() {
  let now = 0, id = 0;
  const timers = new Map(), events = [];
  const r = new PhoneGestureRecognizer((type, x, y) => events.push({ type, x, y }), {
    set(fn, ms) { timers.set(++id, { fn, at: now + ms }); return id; },
    clear(id) { timers.delete(id); },
  });
  return {
    r, events,
    touch: (action, x = 20, y = 30, pointers = 1) => r.touch({ action, x, y, pointers }),
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.fn();
    },
    types: () => events.map(e => e.type),
  };
}
test('single tap retains mirror coordinates and waits to disambiguate double tap', () => {
  const s = setup(); s.touch('down'); s.touch('up');
  assert.deepEqual(s.types(), ['press']); s.advance(280);
  assert.deepEqual(s.events, [{ type: 'press', x: 20, y: 30 }, { type: 'tap', x: 20, y: 30 }]);
});
test('every first-finger touch-down presses; a far second touch flushes the pending tap first', () => {
  const s = setup(); s.touch('down'); s.touch('up'); s.advance(100);
  s.touch('down', 200, 30); s.touch('down', 201, 30, 2); s.touch('up', 201, 30, 2); s.touch('up', 200, 30); s.advance(1000);
  assert.deepEqual(s.types(), ['press', 'tap', 'press', 'double-tap']);
});
test('double tap emits back without accidental selection', () => {
  const s = setup(); s.touch('down'); s.touch('up'); s.advance(150);
  s.touch('down'); s.touch('up'); s.advance(1000);
  assert.deepEqual(s.types(), ['press', 'press', 'double-tap']);
});
test('a hold emits a press and release, never a tap', () => {
  const s = setup(); s.touch('down'); s.advance(500); s.touch('up'); s.advance(1000);
  assert.deepEqual(s.types(), ['press', 'long-press', 'long-press-release']);
});
test('tap then hold emits the app-menu gesture without an earlier selection', () => {
  const s = setup(); s.touch('down'); s.touch('up'); s.advance(100);
  s.touch('down'); s.advance(500); s.touch('up'); s.advance(1000);
  assert.deepEqual(s.types(), ['press', 'press', 'short-then-long-press', 'long-press-release']);
});
test('four directional swipes cancel pending holds and taps', () => {
  for (const [x, y, expected] of [[80, 30, 'swipe-right'], [-40, 30, 'swipe-left'], [20, 90, 'swipe-down'], [20, -30, 'swipe-up']]) {
    const s = setup(); s.touch('down'); s.touch('move', x, y); s.advance(500); s.touch('up', x, y); s.advance(500);
    assert.deepEqual(s.types(), ['press', expected]);
  }
});
test('two fingers send back exactly once and cancel the long-press timer', () => {
  const s = setup(); s.touch('down'); s.touch('down', 21, 30, 2); s.advance(500);
  s.touch('up', 21, 30, 2); s.touch('up'); s.advance(1000);
  assert.deepEqual(s.types(), ['press', 'double-tap']);
});
test('cancellation prevents delayed selections and releases active holds', () => {
  const s = setup(); s.touch('down'); s.touch('up'); s.r.cancel(); s.advance(1000);
  assert.deepEqual(s.types(), ['press']);
  s.touch('down'); s.advance(500); s.touch('cancel'); s.advance(1000);
  assert.deepEqual(s.types(), ['press', 'press', 'long-press', 'long-press-release']);
});
