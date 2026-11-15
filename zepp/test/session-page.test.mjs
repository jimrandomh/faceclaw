import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleState, watchFixture } from './fixture.mjs';

test('page activates the link before its initial read and suspends it across sleep', async t => {
  const w = watchFixture(); t.after(() => w.page.onDestroy());
  assert.deepEqual(w.sessionEvents, [['awake', true]]);
  await w.reply(); w.screen(2);
  assert.deepEqual(w.sessionEvents.at(-1), ['awake', false]);
  w.screen(1);
  assert.deepEqual(w.sessionEvents.at(-1), ['awake', true]);
  assert.equal(w.requests.at(-1).operation.kind, 'state');
  await w.reply();
});

test('failed action invalidates readiness and only a state read follows, never a replay', async t => {
  const w = watchFixture(); t.after(() => w.page.onDestroy()); await w.reply();
  w.page.gesture('swipe-left'); await w.reject('request timeout');
  assert.deepEqual(w.sessionEvents.at(-1), ['invalidate', 'Request failed']);
  assert.equal(w.page.commandFeedback.snapshot().phase, 'unknown');
  assert.equal(w.requests.at(-1).operation.kind, 'state');
  await w.reply();
  assert.equal(w.requests.filter(r => r.operation.kind === 'gesture').length, 1);
});

test('lower button disposes readiness once while a request is pending', async () => {
  const w = watchFixture(); w.key(8); w.page.onDestroy();
  assert.equal(w.exits(), 1);
  assert.equal(w.sessionEvents.filter(([event]) => event === 'dispose').length, 1);
  await w.reply();
  assert.equal(w.requests.length, 1);
});

test('a session guard that proves no send reports Not sent rather than uncertain execution', async t => {
  const w = watchFixture(); t.after(() => w.page.onDestroy()); await w.reply();
  w.page.gesture('swipe-left');
  const error = new Error('Refresh the connection before sending'); error.notSent = true;
  await w.reject(error);
  const feedback = w.page.commandFeedback.snapshot();
  assert.equal(feedback.phase, 'blocked'); assert.match(feedback.text, /Not sent/);
  assert.equal(w.requests.at(-1).operation.kind, 'state'); await w.reply();
  assert.equal(w.requests.filter(r => r.operation.kind === 'gesture').length, 1);
});

test('a state reply spanning sleep/wake cannot replace current state or release queued input', async t => {
  const w = watchFixture(); t.after(() => w.page.onDestroy()); await w.reply();
  const before = w.page.phoneState;
  w.page.refresh(); w.page.gesture('swipe-left');
  w.screen(2); w.screen(1);
  await w.reply({ ok: true, state: { ...sampleState, connected: false } });
  assert.equal(w.page.phoneState, before);
  assert.equal(w.requests.filter(r => r.operation.kind === 'gesture').length, 0);
  assert.equal(w.requests.at(-1).operation.kind, 'state');
  await w.reply();
  assert.equal(w.page.phoneState.connected, true);
});

test('a canceled pre-sleep read starts fresh on wake even if its error arrives after wake', async t => {
  const w = watchFixture(); t.after(() => w.page.onDestroy()); await w.reply();
  w.page.refresh(); w.screen(2); w.screen(1);
  const count = w.requests.length;
  await w.reject('Watch screen is off');
  assert.equal(w.requests.length, count + 1);
  assert.equal(w.requests.at(-1).operation.kind, 'state');
  await w.reply(); assert.equal(w.page.linkError, '');
});
