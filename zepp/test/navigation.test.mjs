import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavigationSide } from '../lib/navigation-side.js';
import { sampleState, watchFixture } from './fixture.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));
function sideFixture() {
  let now = 10000, timer = 0;
  const timers = new Map(), sent = [], waiting = [];
  const side = createNavigationSide({ now: () => now, start: (fn, ms) => { timers.set(++timer, { fn, at: now + ms }); return timer; }, stop: id => timers.delete(id),
    send: (operation, id, metadata) => { sent.push({ operation, id, metadata }); return new Promise((resolve, reject) => waiting.push({ resolve, reject })); } });
  side.register('session1', 'window:a');
  const enqueue = (sequence, gesture = 'swipe-down', context = 'window:a') => side.enqueue({ operation: { kind: 'gesture', gesture }, requestId: 'fc-test-' + sequence, navigation: { sessionId: 'session1', sequence, context } });
  return { side, sent, enqueue,
    advance(ms) { now += ms; for (const [id, value] of timers) if (value.at <= now && timers.delete(id)) value.fn(); },
    async reply(result = { ok: true, navigation: { version: 1, context: 'window:a' } }) { waiting.shift().resolve(result); await flush(); },
    async fail() { waiting.shift().reject(new Error('timeout')); await flush(); },
  };
}
test('four rapid directions queue before HTTP, preserve order, and never overlap POSTs', async () => {
  const f = sideFixture(); const directions = ['swipe-up', 'swipe-down', 'swipe-left', 'swipe-right'];
  const replies = directions.map((g, i) => f.enqueue(i + 1, g));
  assert.equal(f.sent.length, 1); assert.equal((await f.enqueue(5)).notSent, true);
  for (let i = 0; i < 4; i++) { assert.equal(f.sent.length, i + 1); await f.reply(); }
  assert.deepEqual(f.sent.map(item => item.operation.gesture), directions);
  assert.ok((await Promise.all(replies)).every(item => item.ok));
  assert.equal(f.side.busy(), false);
});
test('pending directions expire without waiting for a stalled HTTP request', async () => {
  const f = sideFixture(); const first = f.enqueue(1), next = f.enqueue(2);
  f.advance(1000); assert.equal((await next).code, 'expired'); assert.equal(f.sent.length, 1);
  await f.reply(); assert.equal((await first).ok, true); assert.equal(f.sent.length, 1);
});
test('cancel and changed context stop unsent gestures and retire the old session', async () => {
  for (const cancel of [true, false]) {
    const f = sideFixture(); const first = f.enqueue(1), next = f.enqueue(2);
    if (cancel) f.side.cancel('session1');
    await f.reply({ ok: true, navigation: { version: 1, context: 'window:b' } });
    assert.equal((await first).ok, true); assert.equal((await next).notSent, true); assert.equal(f.sent.length, 1);
    if (cancel) assert.equal(f.side.register('session1', 'window:a'), false);
  }
});
test('unknown prior outcome flushes all waiting input, never restarting after late success', async () => {
  const f = sideFixture(); const first = f.enqueue(1), second = f.enqueue(2), third = f.enqueue(3);
  await f.fail(); assert.equal((await first).notSent, false);
  assert.equal((await second).notSent, true); assert.equal((await third).notSent, true);
  assert.equal(f.sent.length, 1); assert.equal((await f.enqueue(4)).code, 'session_changed');
});
test('duplicate and reordered sequences cannot execute twice', async () => {
  const f = sideFixture(); const first = f.enqueue(1);
  assert.equal((await f.enqueue(1)).code, 'out_of_order'); assert.equal((await f.enqueue(3)).code, 'out_of_order');
  await f.reply(); await first;
  const second = f.enqueue(2); await f.reply(); await second; assert.equal(f.sent.length, 2);
});
const state = { ...sampleState, navigationSupported: true, navigationContext: 'window:a' };
async function watch(t) { const w = watchFixture(); t.after(() => w.page.onDestroy()); await w.reply({ ok: true, state: { ...state } }); return w; }
const directions = w => w.requests.filter(item => item.navigation);
const success = { ok: true, navigation: { version: 1, context: 'window:a' } };
test('watch sends four directional requests immediately using one session and distinct sequences', async t => {
  const w = await watch(t);
  for (const gesture of ['swipe-up', 'swipe-down', 'swipe-left', 'swipe-right']) w.page.gesture(gesture);
  assert.equal(directions(w).length, 4); assert.equal(w.page.busyKind, 'navigation');
  assert.deepEqual(directions(w).map(item => item.navigation.sequence), [1, 2, 3, 4]);
  assert.equal(new Set(directions(w).map(item => item.navigation.sessionId)).size, 1);
  w.page.gesture('swipe-up'); assert.equal(directions(w).length, 4);
  assert.match(w.page.commandFeedback.snapshot().text, /Too many swipes/);
  for (let i = 0; i < 4; i++) await w.reply(success);
  assert.equal(w.page.busy, false); assert.equal(w.requests.length, 5);
});
test('taps and app commands cannot overtake a directional burst', async t => {
  const w = await watch(t); w.page.gesture('swipe-up'); w.page.gesture('click');
  assert.equal(w.requests.length, 2); assert.match(w.page.commandFeedback.snapshot().text, /Not sent/);
  await w.reply(success); assert.equal(w.requests.length, 2);
});
test('context change ends the burst and refreshes status without replaying gestures', async t => {
  const w = await watch(t); w.page.gesture('swipe-right');
  await w.reply({ ok: true, navigation: { version: 1, context: 'window:b' } });
  assert.equal(w.requests.at(-1).operation.kind, 'state');
  assert.ok(w.sessionEvents.some(([event]) => event === 'cancelNavigation'));
  await w.reply({ ok: true, state: { ...state, navigationContext: 'window:b' } });
  assert.equal(directions(w).length, 1);
});
test('sleep cancels queued phone input and late replies cannot restore the old burst', async t => {
  const w = await watch(t); w.page.gesture('swipe-up'); w.page.gesture('swipe-down');
  const old = directions(w)[0].navigation.sessionId;
  w.screen(2); w.screen(1);
  assert.ok(w.sessionEvents.some(([event, id]) => event === 'cancelNavigation' && id === old));
  await w.reply(success); await w.reply(success); await w.reply({ ok: true, state: { ...state } });
  assert.equal(w.page.busy, false); assert.equal(directions(w).length, 2); assert.notEqual(w.page.navSession, old);
});
test('uncertain burst response resets session and never repeats the gesture', async t => {
  const w = await watch(t); w.page.gesture('swipe-up'); await w.reject('timeout');
  assert.equal(w.page.commandFeedback.snapshot().phase, 'unknown');
  assert.equal(w.requests.at(-1).operation.kind, 'state'); await w.reply({ ok: true, state: { ...state } });
  assert.equal(directions(w).length, 1);
});
test('explicit expired input is not sent and does not trigger another readiness handshake', async t => {
  const w = await watch(t); w.page.gesture('swipe-up'); const count = w.sessionEvents.filter(([event]) => event === 'invalidate').length;
  await w.reply({ ok: false, notSent: true, code: 'expired', error: 'Expired' });
  assert.match(w.page.commandFeedback.snapshot().text, /Swipe expired/);
  assert.equal(w.sessionEvents.filter(([event]) => event === 'invalidate').length, count);
  await w.reply({ ok: true, state: { ...state } }); assert.equal(directions(w).length, 1);
});
