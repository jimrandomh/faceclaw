import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleState, watchFixture } from './fixture.mjs';

const state = { ...sampleState, navigationSupported: true, navigationContext: 'window:a' };
const accepted = { ok: true, navigation: { version: 1, context: 'window:a' } };
const directions = w => w.requests.filter(request => request.navigation);
const starts = w => w.vibrationCalls.filter(([kind]) => kind === 'start');
async function ready(t) {
  const w = watchFixture(); t.after(() => w.page.onDestroy());
  await w.reply({ ok: true, state: { ...state } }); return w;
}
function activeFor(w, ms) {
  // Small movements keep the idle poll deferred without sending a command.
  while (ms > 0) { const step = Math.min(ms, 500); w.advance(step); w.page.noteActivity(); ms -= step; }
}
async function scrollFor(w, count, crown = false) {
  for (let i = 0; i < count; i++) {
    w.advance(500);
    if (crown) w.crown(24, 0); else w.page.gesture(i % 2 ? 'swipe-up' : 'swipe-down');
    assert.equal(directions(w).length, i + 1, 'each deliberate direction should send');
    await w.reply(accepted);
  }
}

for (const crown of [false, true]) test(`continuous successful ${crown ? 'crown' : 'swipe'} input stays ready beyond 15 seconds`, async t => {
  const w = await ready(t), snapshotTime = w.page.stateTime;
  await scrollFor(w, 80, crown);
  assert.equal(w.requests.filter(request => request.operation.kind === 'state').length, 1);
  assert.equal(w.page.commandFeedback.snapshot().phase, 'accepted');
  assert.equal(w.page.stateTime, snapshotTime, 'navigation must not pretend the app/status snapshot was refreshed');
  assert.equal(starts(w).length, 0);
});

test('navigation readiness cannot authorize a tap against a stale status snapshot', async t => {
  const w = await ready(t); await scrollFor(w, 34);
  w.page.gesture('click');
  assert.equal(w.requests.at(-1).operation.kind, 'state');
  assert.equal(w.requests.filter(request => request.operation.gesture === 'click').length, 0);
  assert.equal(w.page.commandFeedback.snapshot().phase, 'skipped');
  assert.equal(starts(w).length, 0);
  await w.reply({ ok: true, state: { ...state } });
  assert.equal(w.requests.filter(request => request.operation.gesture === 'click').length, 0, 'refresh never replays the tap');
  w.page.gesture('click'); assert.equal(w.requests.at(-1).operation.gesture, 'click');
});

test('unacknowledged activity cannot extend readiness, and automatic refresh is silent', async t => {
  const w = await ready(t); w.crown(24, 0); await w.reply(accepted);
  activeFor(w, 15001); w.crown(24, 0);
  assert.equal(directions(w).length, 1); assert.equal(w.requests.at(-1).operation.kind, 'state');
  const feedback = w.page.commandFeedback.snapshot();
  assert.equal(feedback.phase, 'skipped'); assert.match(feedback.text, /Syncing/);
  assert.equal(starts(w).length, 0);
  await w.reply({ ok: true, state: { ...state } });
  assert.equal(directions(w).length, 1, 'refresh must not replay the triggering turn');
  w.crown(24, 500); assert.equal(directions(w).length, 2);
});

test('a delayed acceptance renews from send time rather than reply arrival', async t => {
  const w = await ready(t); activeFor(w, 14000);
  w.page.gesture('swipe-up'); w.advance(10000); await w.reply(accepted);
  activeFor(w, 5001); w.page.gesture('swipe-down');
  assert.equal(directions(w).length, 1); assert.equal(w.requests.at(-1).operation.kind, 'state');
  assert.equal(starts(w).length, 0);
});

test('a rejected direction and later success cannot reopen the same burst', async t => {
  for (const [code, patch] of [
    ['forbidden', { remoteEnabled: false }], ['unavailable', { connected: false }],
    ['locked', { locked: true }], ['context_changed', { screenOn: false }],
  ]) {
    const w = await ready(t); await scrollFor(w, 34);
    w.page.gesture('swipe-up'); w.page.gesture('swipe-down');
    await w.reply({ ok: false, notSent: true, code });
    const count = directions(w).length;
    w.page.gesture('swipe-right');
    assert.equal(directions(w).length, count, code);
    await w.reply(accepted);
    assert.equal(w.requests.at(-1).operation.kind, 'state');
    assert.equal(w.page.navigationTime, 0);
    await w.reply({ ok: true, state: { ...state, ...patch } });
    w.page.gesture('swipe-right'); assert.equal(directions(w).length, count, code);
  }
});

test('changed or incomplete acceptance contexts force a new status read', async t => {
  for (const navigation of [undefined, { version: 1, context: null }, { version: 1, context: 'window:b' }, { version: 2, context: 'window:a' }]) {
    const w = await ready(t); await scrollFor(w, 34);
    w.page.gesture('swipe-up'); await w.reply({ ok: true, navigation });
    assert.equal(w.requests.at(-1).operation.kind, 'state'); assert.equal(w.page.navigationTime, 0);
    const count = directions(w).length;
    await w.reply({ ok: true, state: { ...state, navigationContext: 'window:b' } });
    assert.equal(directions(w).length, count, 'refresh does not repeat the accepted gesture');
    w.page.gesture('swipe-down'); assert.equal(w.requests.at(-1).navigation.context, 'window:b');
  }
});

test('late acceptance across sleep cannot renew readiness or bypass fresh disconnected state', async t => {
  const w = await ready(t); await scrollFor(w, 34);
  w.crown(24, 500); w.screen(2); w.screen(1); await w.reply(accepted);
  assert.equal(w.page.navigationTime, 0); assert.equal(w.requests.at(-1).operation.kind, 'state');
  const count = directions(w).length;
  await w.reply({ ok: true, state: { ...state, connected: false } });
  w.crown(24, 500); assert.equal(directions(w).length, count);
  assert.match(w.page.commandFeedback.snapshot().text, /disconnected/);
});

test('a failed status check overrides otherwise recent navigation readiness', async t => {
  const w = await ready(t); await scrollFor(w, 34);
  w.page.refresh(); await w.reject('No phone reply');
  const count = directions(w).length;
  w.page.gesture('swipe-up'); assert.equal(directions(w).length, count);
  assert.equal(w.requests.at(-1).operation.kind, 'state');
  assert.equal(starts(w).length, 0);
  await w.reply({ ok: true, state: { ...state, locked: true } });
  w.page.gesture('swipe-down'); assert.equal(directions(w).length, count);
  assert.match(w.page.commandFeedback.snapshot().text, /locked/);
});

test('missing navigation context syncs silently and never replays the turn', async t => {
  const w = await ready(t);
  w.page.refresh(); await w.reply({ ok: true, state: { ...state, navigationContext: null } });
  w.crown(24, 500); assert.equal(directions(w).length, 0);
  assert.equal(w.page.commandFeedback.snapshot().phase, 'skipped'); assert.equal(starts(w).length, 0);
  await w.reply({ ok: true, state: { ...state } }); assert.equal(directions(w).length, 0);
  w.crown(24, 500); assert.equal(directions(w).length, 1);
});
