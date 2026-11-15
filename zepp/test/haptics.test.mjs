import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleState, watchFixture } from './fixture.mjs';

const starts = w => w.vibrationCalls.filter(([kind]) => kind === 'start');
const navigationState = { ...sampleState, navigationSupported: true, navigationContext: 'window:a' };
const success = { ok: true, navigation: { version: 1, context: 'window:a' } };
async function ready(t, state = sampleState, options) {
  const w = watchFixture(options); t.after(() => w.page.onDestroy());
  await w.reply({ ok: true, state: { ...state } }); return w;
}

test('rejected, unknown, blocked and expired gestures each vibrate once', async t => {
  for (const outcome of ['rejected', 'unknown', 'blocked', 'expired']) {
    const w = await ready(t, outcome === 'expired' ? navigationState : outcome === 'blocked' ? { ...sampleState, locked: true } : sampleState);
    w.page.gesture('swipe-up');
    if (outcome === 'rejected') await w.reply({ ok: false, error: 'Unavailable' });
    if (outcome === 'unknown') await w.reject('timeout');
    if (outcome === 'expired') await w.reply({ ok: false, notSent: true, code: 'expired' });
    assert.deepEqual(starts(w), [['start', 7]], outcome);
    const feedback = w.page.commandFeedback.snapshot();
    w.page.commandFeedback.finish(feedback.id, 'failed'); w.page.renderFeedback();
    assert.equal(starts(w).length, 1, 'duplicate results and repainting do not vibrate again');
    w.advance(1000); assert.equal(w.page.failureVibrationTimer, null);
    assert.deepEqual(w.vibrationCalls.at(-1), ['stop']);
  }
});

test('an older in-flight swipe failure vibrates without replacing newer feedback', async t => {
  const w = await ready(t, navigationState);
  w.page.gesture('swipe-up'); w.page.gesture('swipe-down');
  const newest = w.page.commandFeedback.snapshot();
  await w.reply({ ok: false, notSent: true, code: 'expired' });
  assert.equal(starts(w).length, 1);
  assert.equal(w.page.commandFeedback.snapshot().id, newest.id);
  assert.equal(w.page.commandFeedback.snapshot().phase, 'sending');
  await w.reply(success);
  assert.equal(starts(w).length, 1); assert.equal(w.page.commandFeedback.snapshot().phase, 'accepted');
});

test('successful gestures, status checks and failed app commands do not vibrate', async t => {
  const w = await ready(t); w.page.gesture('swipe-up'); await w.reply({ ok: true });
  w.page.navigate('apps'); await w.reply(); w.page.select(3); w.page.activate();
  await w.reply({ ok: false, error: 'Unavailable' });
  assert.equal(starts(w).length, 0);
});

test('replaced or expired crown input waiting behind a status read is quietly skipped', async t => {
  const w = await ready(t); w.page.refresh();
  w.crown(-24, 10); w.crown(-24, 300); w.crown(24, 300);
  assert.equal(starts(w).length, 0);
  w.advance(351); assert.equal(starts(w).length, 0);
  assert.equal(w.page.commandFeedback.snapshot().phase, 'skipped');
  await w.reply(); assert.equal(starts(w).length, 0);
  assert.equal(w.calls.filter(c => c.kind === 'gesture').length, 0);
});

test('sleep, navigation and exit stop vibration and suppress late gesture failures', async t => {
  for (const cancel of [w => w.screen(2), w => w.page.navigate('apps'), w => w.key(8)]) {
    const w = await ready(t, navigationState);
    w.page.gesture('swipe-up'); w.page.gesture('swipe-down');
    await w.reply({ ok: false, notSent: true, code: 'expired' });
    assert.equal(starts(w).length, 1);
    cancel(w);
    assert.equal(w.page.failureVibrationTimer, null); assert.deepEqual(w.vibrationCalls.at(-1), ['stop']);
    await w.reply({ ok: false, error: 'Unavailable' });
    assert.equal(starts(w).length, 1);
  }
});

test('unavailable vibration hardware cannot interfere with command failure or recovery', async t => {
  const w = await ready(t, sampleState, { vibrationError: true });
  w.page.gesture('swipe-up'); await w.reject('timeout');
  assert.equal(w.page.commandFeedback.snapshot().phase, 'unknown');
  assert.equal(w.calls.at(-1).kind, 'state');
  assert.equal(w.page.failureVibrationTimer, null);
});

test('a sent crown command with an unknown result still vibrates once despite excess rotation', async t => {
  const w = await ready(t, navigationState);
  w.crown(-24, 10); w.crown(-720, 300); w.crown(720, 300);
  await w.reject('timeout');
  assert.equal(starts(w).length, 1); assert.equal(w.page.commandFeedback.snapshot().phase, 'unknown');
  assert.equal(w.calls.filter(c => c.kind === 'gesture').length, 1);
});
