import test from 'node:test';
import assert from 'node:assert/strict';
import { createTouchpad } from '../lib/model.js';

function fixture(onEmit) {
  let now = 0, timerId = 0;
  const timers = new Map(), events = [];
  let pad;
  pad = createTouchpad((gesture, info) => {
    events.push({ gesture, info, at: now });
    onEmit?.(gesture, pad);
  }, {
    setTimeout(callback, delay) { timers.set(++timerId, { callback, at: now + delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  return {
    pad, timers, events,
    down(x = 200, y = 200) { pad.down(x, y, now); },
    move(x, y) { pad.move(x, y); },
    up(x = 200, y = 200) { pad.up(x, y, now); },
    jump(ms) { now += ms; },
    advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = Math.max(now, next[1].at); timers.delete(next[0]); next[1].callback();
      }
      now = end;
    },
    kinds() { return events.map(event => event.gesture); },
    callbackAt(at) { return [...timers.values()].find(timer => timer.at === at)?.callback; },
  };
}

test('hold emits exactly at 600ms while down, with no release or later movement gesture', () => {
  const f = fixture(); f.down(); f.advance(599); assert.deepEqual(f.kinds(), []);
  f.advance(1); assert.deepEqual(f.kinds(), ['long-press']); assert.equal(f.events[0].at, 600);
  assert.equal(f.timers.size, 0);
  f.move(100, 200); f.up(100, 200); f.advance(1000);
  assert.deepEqual(f.kinds(), ['long-press']); assert.equal(f.timers.size, 0);
});

test('tap then held second contact emits short-then-long at 600ms after the second down', () => {
  const f = fixture(); f.down(); f.advance(50); f.up();
  const oldTap = f.callbackAt(350);
  f.advance(100); f.down(); oldTap();
  f.advance(599); assert.deepEqual(f.kinds(), []);
  f.advance(1); assert.deepEqual(f.kinds(), ['short-then-long-press']); assert.equal(f.events[0].at, 750);
  f.up(); f.advance(1000); assert.deepEqual(f.kinds(), ['short-then-long-press']); assert.equal(f.timers.size, 0);
});

test('a still-pending first tap belongs to a second down at exactly 300ms', () => {
  const f = fixture(); f.down(); f.jump(50); f.up();
  const oldTap = f.callbackAt(350);
  f.jump(300); f.down(); oldTap(); f.advance(600);
  assert.deepEqual(f.kinds(), ['short-then-long-press']); f.up(); assert.equal(f.timers.size, 0);
});

test('a second contact after the double-tap window is an independent hold', () => {
  const f = fixture(); f.down(); f.advance(50); f.up(); f.advance(301);
  assert.deepEqual(f.kinds(), ['click']); f.down(); f.advance(600);
  assert.deepEqual(f.kinds(), ['click', 'long-press']); f.up(); assert.equal(f.timers.size, 0);
});

test('an overdue tap is resolved before a new press even when its callback resets the recognizer', () => {
  const f = fixture((_gesture, pad) => pad.reset());
  f.down(); f.jump(50); f.up(); const staleTap = f.callbackAt(350);
  f.jump(301); f.down();
  assert.deepEqual(f.kinds(), ['click']); assert.equal(f.timers.size, 1);
  staleTap(); assert.deepEqual(f.kinds(), ['click']);
  f.advance(599); assert.deepEqual(f.kinds(), ['click']); f.advance(1);
  assert.deepEqual(f.kinds(), ['click', 'long-press']); f.up(); assert.equal(f.timers.size, 0);
});

test('a reentrant new down during an overdue tap is not overwritten by the outer down', () => {
  let f;
  f = fixture((gesture, pad) => { if (gesture === 'click') pad.down(300, 300, 351); });
  f.down(); f.jump(50); f.up(); f.jump(301); f.down(200, 200);
  f.move(300, 300); f.advance(600);
  assert.deepEqual(f.kinds(), ['click', 'long-press']); f.up(300, 300); assert.equal(f.timers.size, 0);
});

test('single tap still waits 300ms and a quick double-tap emits only once', () => {
  const single = fixture(); single.down(); single.advance(50); single.up();
  single.advance(299); assert.deepEqual(single.kinds(), []); single.advance(1); assert.deepEqual(single.kinds(), ['click']);
  const double = fixture(); double.down(); double.advance(50); double.up(); double.advance(100); double.down();
  const staleHold = double.callbackAt(750); double.advance(50); double.up(); staleHold(); double.advance(1000);
  assert.deepEqual(double.kinds(), ['double-click']); assert.equal(double.timers.size, 0);
});

test('release before 600ms cancels hold and leaves only the normal tap', () => {
  const f = fixture(); f.down(); const staleHold = f.callbackAt(600);
  f.advance(599); f.up(); staleHold(); f.advance(300);
  assert.deepEqual(f.kinds(), ['click']); assert.equal(f.timers.size, 0);
});

test('30px drift still allows hold but greater drift permanently cancels it', () => {
  const edge = fixture(); edge.down(); edge.move(230, 200); edge.advance(600);
  assert.deepEqual(edge.kinds(), ['long-press']); edge.up(230, 200);
  const moved = fixture(); moved.down(); const oldHold = moved.callbackAt(600);
  moved.advance(300); moved.move(231, 200); moved.move(200, 200); oldHold(); moved.advance(400); moved.up(); moved.advance(300);
  assert.deepEqual(moved.kinds(), []); assert.equal(moved.timers.size, 0);
});

test('movement cancels a second-contact hold and retains the existing swipe threshold', () => {
  const f = fixture(); f.down(); f.advance(50); f.up(); f.advance(100); f.down();
  const oldHold = f.callbackAt(750); f.move(240, 200); f.advance(600); oldHold(); f.up(240, 200); f.advance(300);
  assert.deepEqual(f.kinds(), ['swipe-right']); assert.equal(f.timers.size, 0);
});

test('all four release swipes retain direction and starting Y with no click or hold', () => {
  for (const [endX, endY, expected] of [[160, 200, 'swipe-left'], [240, 200, 'swipe-right'], [200, 160, 'swipe-up'], [200, 240, 'swipe-down']]) {
    const f = fixture(); f.down(); f.move(endX, endY); f.advance(700); f.up(endX, endY); f.advance(300);
    assert.deepEqual(f.kinds(), [expected]); assert.equal(f.events[0].info.startY, 200); assert.equal(f.timers.size, 0);
  }
});

test('a release between drift and swipe thresholds is not a tap or delayed hold', () => {
  for (const duration of [50, 650]) {
    const f = fixture(); f.down(); f.jump(duration); f.up(239, 200); f.advance(1000);
    assert.deepEqual(f.kinds(), []); assert.equal(f.timers.size, 0);
  }
});

test('release-time hold fallback fires once if the timer was delayed', () => {
  for (const duration of [600, 900]) {
    const f = fixture(); f.down(); const oldHold = f.callbackAt(600);
    f.jump(duration); f.up(); oldHold(); f.advance(1000);
    assert.deepEqual(f.kinds(), ['long-press']); assert.equal(f.timers.size, 0);
  }
});

test('release-time tap-then-hold fallback also cancels its delayed timers', () => {
  const f = fixture(); f.down(); f.jump(50); f.up(); const oldTap = f.callbackAt(350);
  f.jump(100); f.down(); const oldHold = f.callbackAt(750);
  f.jump(600); f.up(); oldTap(); oldHold(); f.advance(1000);
  assert.deepEqual(f.kinds(), ['short-then-long-press']); assert.equal(f.timers.size, 0);
});

test('synchronous reset during timed recognition cannot cause an additional release gesture', () => {
  const f = fixture((_gesture, pad) => pad.reset()); f.down(); f.advance(600);
  f.move(100, 200); f.up(100, 200); f.advance(1000);
  assert.deepEqual(f.kinds(), ['long-press']); assert.equal(f.timers.size, 0);
  f.down(); f.advance(50); f.up(); f.advance(300);
  assert.deepEqual(f.kinds(), ['long-press', 'click']); assert.equal(f.timers.size, 0);
});

test('a new down created during hold emission retains its own timer and identity', () => {
  let count = 0;
  const f = fixture((_gesture, pad) => { if (++count === 1) pad.down(300, 300, 600); });
  f.down(); const oldHold = f.callbackAt(600); f.advance(600); oldHold();
  assert.deepEqual(f.kinds(), ['long-press']); assert.equal(f.timers.size, 1);
  f.advance(600); assert.deepEqual(f.kinds(), ['long-press', 'long-press']); f.up(300, 300); assert.equal(f.timers.size, 0);
});

test('reset cancels both hold and tap callbacks, including callbacks already captured by the event loop', () => {
  for (const tapped of [false, true]) {
    const f = fixture(); f.down();
    if (tapped) { f.jump(50); f.up(); }
    const callbacks = [...f.timers.values()].map(timer => timer.callback);
    f.pad.reset(); callbacks.forEach(callback => callback()); f.advance(2000);
    assert.deepEqual(f.kinds(), []); assert.equal(f.timers.size, 0);
  }
});

test('new down cancels the previous hold and late old timers cannot act on the new contact', () => {
  const f = fixture(); f.down(); const oldHold = f.callbackAt(600); f.advance(400); f.down(300, 300);
  oldHold(); f.advance(599); assert.deepEqual(f.kinds(), []);
  f.advance(1); assert.deepEqual(f.kinds(), ['long-press']); assert.equal(f.events[0].at, 1000);
  f.up(300, 300); assert.equal(f.timers.size, 0);
});

test('invalid coordinates or time cancel active contact timers without emitting', () => {
  for (const invalid of [
    pad => pad.down(NaN, 200, 0), pad => pad.down(200, 200, Infinity),
    pad => pad.move(NaN, 200), pad => pad.move(200, undefined),
    pad => pad.up(Infinity, 200, 0), pad => pad.up(200, 200, NaN), pad => pad.up(200, 200, -1),
  ]) {
    const f = fixture(); f.down(); const oldHold = f.callbackAt(600); invalid(f.pad); oldHold(); f.advance(2000);
    assert.deepEqual(f.kinds(), []); assert.equal(f.timers.size, 0);
  }
});

test('invalid input also cancels a pending tap, while an extra valid up does not duplicate it', () => {
  const invalid = fixture(); invalid.down(); invalid.jump(50); invalid.up(); const oldTap = invalid.callbackAt(350);
  invalid.pad.move(NaN, 200); oldTap(); invalid.advance(1000);
  assert.deepEqual(invalid.kinds(), []); assert.equal(invalid.timers.size, 0);
  const extra = fixture(); extra.down(); extra.jump(50); extra.up(); extra.up(); extra.advance(300);
  assert.deepEqual(extra.kinds(), ['click']); assert.equal(extra.timers.size, 0);
});
