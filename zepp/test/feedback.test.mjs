import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandFeedback, operationLabel } from '../lib/feedback.js';

function fixture() {
  let time = 1000, timerId = 0;
  const timers = new Map(), changes = [];
  const feedback = createCommandFeedback(value => changes.push(value), {
    now: () => time,
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, at: time + delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
  });
  return {
    feedback, timers, changes,
    setTime(value) { time = value; },
    advance(ms) {
      const end = time + ms;
      while (true) {
        const ready = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!ready) break;
        time = ready[1].at; timers.delete(ready[0]); ready[1].callback();
      }
      time = end;
    },
  };
}
const swipe = { kind: 'gesture', gesture: 'swipe-left' };

test('operation labels are concise and never expose raw app or window IDs', () => {
  const gestures = { click: 'Tap', 'double-click': 'Double tap', 'long-press': 'Long press',
    'short-then-long-press': 'Tap then hold', 'scroll-up': 'Scroll up', 'scroll-down': 'Scroll down',
    'swipe-up': 'Swipe up', 'swipe-down': 'Swipe down', 'swipe-left': 'Swipe left', 'swipe-right': 'Swipe right' };
  for (const [gesture, label] of Object.entries(gestures)) assert.equal(operationLabel({ kind: 'gesture', gesture }), label);
  const commands = { 'launch-app': 'Open app', 'focus-window': 'Show app', 'close-window': 'Close app',
    sidebar: 'Glasses menu', wake: 'Wake glasses', sleep: 'Sleep glasses', lock: 'Lock glasses', unlock: 'Unlock glasses',
    connect: 'Connect glasses', disconnect: 'Disconnect glasses', 'close-assistant': 'Close assistant' };
  for (const [command, label] of Object.entries(commands)) assert.equal(operationLabel({ kind: 'command', command, appId: 'private-id', windowId: 'private-id' }), label);
  assert.equal(operationLabel({ kind: 'state' }), 'Refresh status');
  assert.equal(operationLabel(null), 'Watch command');
  assert.equal(operationLabel({ kind: 'gesture', gesture: 'unsupported' }), 'Gesture');
  assert.equal(operationLabel({ kind: 'command', command: 'unsupported' }), 'Watch command');
  assert.equal(operationLabel({ kind: 'gesture', gesture: '__proto__' }), 'Gesture');
  assert.equal(operationLabel({ kind: 'command', command: 'toString' }), 'Watch command');
});

test('begin reports synchronously, ticks elapsed time and produces page-specific bounded IDs', () => {
  const f = fixture(), other = fixture();
  const id = f.feedback.begin(swipe), otherId = other.feedback.begin(swipe);
  assert.match(id, /^fc-[a-z0-9]+-[a-z0-9]+$/); assert.ok(id.length <= 96); assert.notEqual(id, otherId);
  assert.deepEqual(f.changes, [{ id, text: 'Swipe left\nSending · 0s', error: false, pending: true, phase: 'sending' }]);
  f.advance(2100);
  assert.equal(f.changes.length, 3); assert.equal(f.changes.at(-1).text, 'Swipe left\nSending · 2s');
  assert.equal(f.timers.size, 1);
  f.feedback.clear(); other.feedback.clear();
});

test('queued progress advances monotonically without resetting its elapsed timer', () => {
  const f = fixture(), id = f.feedback.begin(swipe, 'waiting');
  assert.equal(f.feedback.snapshot().phase, 'queued'); assert.equal(f.feedback.snapshot().text, 'Swipe left\nWaiting · 0s');
  f.advance(1200); f.feedback.update(id, 'sending');
  assert.equal(f.feedback.snapshot().text, 'Swipe left\nSending · 1s');
  f.feedback.update(id, 'phone-received'); const count = f.changes.length;
  f.feedback.update(id, 'sending'); f.feedback.update(id, 'queued'); f.feedback.update(id, 'phone-received'); f.feedback.update(id, 'unsupported');
  assert.equal(f.changes.length, count); assert.equal(f.feedback.snapshot().text, 'Swipe left\nPhone received · 1s');
  f.advance(800); assert.equal(f.feedback.snapshot().text, 'Swipe left\nPhone received · 2s');
  f.feedback.clear();
});

test('accepted feedback is terminal, times the whole request and expires after three seconds', () => {
  const f = fixture(), id = f.feedback.begin(swipe, 'queued');
  f.advance(1200); f.feedback.finish(id, 'accepted');
  assert.deepEqual(f.feedback.snapshot(), { id, text: 'Swipe left\nFaceclaw accepted · 1.2s', error: false, pending: false, phase: 'accepted' });
  const count = f.changes.length;
  f.feedback.update(id, 'phone-received'); f.feedback.finish(id, 'failed');
  assert.equal(f.changes.length, count);
  f.advance(2999); assert.equal(f.changes.length, count); assert.equal(f.feedback.snapshot().phase, 'accepted');
  f.advance(1); assert.equal(f.feedback.snapshot(), null); assert.equal(f.changes.at(-1), null); assert.equal(f.timers.size, 0);
});

test('failure and unknown remain distinct, use error styling and expire after five seconds', () => {
  for (const [phase, line] of [['failed', 'Not accepted'], ['unknown', 'Result unknown']]) {
    const f = fixture(), id = f.feedback.begin(swipe);
    f.feedback.finish(id, phase, 'transport internals must not replace the concise label');
    assert.equal(f.feedback.snapshot().text, 'Swipe left\n' + line); assert.equal(f.feedback.snapshot().error, true);
    f.advance(4999); assert.equal(f.feedback.snapshot().phase, phase);
    f.advance(1); assert.equal(f.feedback.snapshot(), null); assert.equal(f.timers.size, 0);
  }
});

test('blocked and skipped accept short single-line reasons with appropriate durations', () => {
  for (const [phase, detail, error, duration] of [
    ['blocked', 'Double tap to wake', true, 5000], ['skipped', 'Turn crown again', false, 3000],
  ]) {
    const f = fixture(), id = f.feedback.begin(swipe);
    f.feedback.finish(id, phase, detail);
    assert.equal(f.feedback.snapshot().text, 'Swipe left\n' + detail); assert.equal(f.feedback.snapshot().error, error);
    f.advance(duration); assert.equal(f.feedback.snapshot(), null); assert.equal(f.timers.size, 0);
  }
  const f = fixture(), id = f.feedback.begin(swipe);
  f.feedback.finish(id, 'blocked', '  Unlock\n on\tphone\u0000   ' + 'x'.repeat(100));
  const lines = f.feedback.snapshot().text.split('\n');
  assert.equal(lines.length, 2); assert.ok(lines[1].length <= 26); assert.match(lines[1], /^Unlock on phone /);
  f.feedback.clear();
});

test('new intents supersede old IDs and canceled callbacks cannot affect the current timer', () => {
  const f = fixture(), oldId = f.feedback.begin(swipe);
  const staleTick = [...f.timers.values()][0].callback;
  const id = f.feedback.begin({ kind: 'gesture', gesture: 'swipe-right' }, 'queued');
  assert.notEqual(id, oldId); const count = f.changes.length;
  f.feedback.update(oldId, 'phone-received'); f.feedback.finish(oldId, 'accepted'); staleTick();
  assert.equal(f.changes.length, count); assert.equal(f.feedback.snapshot().id, id); assert.equal(f.timers.size, 1);
  f.feedback.finish(id, 'accepted'); const staleExpiry = [...f.timers.values()][0].callback;
  const newerId = f.feedback.begin(swipe); staleExpiry();
  assert.equal(f.feedback.snapshot().id, newerId); assert.equal(f.timers.size, 1);
  f.feedback.clear(); assert.equal(f.timers.size, 0);
});

test('clear is synchronous and prevents every delayed or late progress event', () => {
  for (const finishFirst of [false, true]) {
    const f = fixture(), id = f.feedback.begin(swipe);
    if (finishFirst) f.feedback.finish(id, 'accepted');
    const staleCallback = [...f.timers.values()][0].callback;
    f.feedback.clear(); assert.equal(f.feedback.snapshot(), null); assert.equal(f.changes.at(-1), null); assert.equal(f.timers.size, 0);
    const count = f.changes.length;
    staleCallback(); f.feedback.update(id, 'phone-received'); f.feedback.finish(id, 'unknown'); f.advance(20000);
    assert.equal(f.changes.length, count); assert.equal(f.timers.size, 0);
  }
});

test('snapshots cannot mutate internal state and elapsed time cannot run backward', () => {
  const f = fixture(), id = f.feedback.begin(swipe);
  f.advance(1200); const snapshot = f.feedback.snapshot(); snapshot.phase = 'failed'; snapshot.text = 'corrupt';
  f.setTime(1100); assert.equal(f.feedback.snapshot().text, 'Swipe left\nSending · 1s');
  f.feedback.finish(id, 'accepted'); assert.equal(f.feedback.snapshot().text, 'Swipe left\nFaceclaw accepted · 1.2s');
  f.feedback.clear();
});

test('unknown stages and phases cannot corrupt active feedback', () => {
  const f = fixture(), id = f.feedback.begin(swipe, 'unsupported');
  assert.equal(f.feedback.snapshot().phase, 'sending');
  const count = f.changes.length;
  f.feedback.update(id, '__proto__'); f.feedback.finish(id, 'phone-received'); f.feedback.finish('wrong-id', 'failed');
  assert.equal(f.changes.length, count); assert.equal(f.feedback.snapshot().pending, true);
  f.feedback.clear();
});


test('a change callback may clear feedback without leaving a timer behind', () => {
  const timers = new Map(); let timerId = 0, feedback, changes = 0;
  feedback = createCommandFeedback(value => {
    changes++;
    if (value) feedback.clear();
  }, {
    now: () => 1000,
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
  });
  feedback.begin(swipe);
  assert.equal(changes, 2); assert.equal(feedback.snapshot(), null); assert.equal(timers.size, 0);
});
