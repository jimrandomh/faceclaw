import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleState, watchFixture } from './fixture.mjs';

async function ready(t, state = sampleState) {
  const watch = watchFixture();
  t.after(() => watch.page.onDestroy());
  await watch.reply({ ok: true, state });
  return watch;
}
const snapshot = watch => watch.page.commandFeedback.snapshot();
const commands = watch => watch.requests.filter(request => request.operation.kind !== 'state');
const receipt = (watch, requestId, stage = 'phone-received') => watch.page.onCall({
  method: 'FACECLAW_PROGRESS', params: { requestId, stage },
});
function swipeLeft(watch) {
  watch.touch('down', 260, 230);
  watch.touch('move', 160, 230, 20);
  watch.touch('up', 160, 230, 40);
}
function visibleFeedback(watch, phase, text) {
  const feedback = snapshot(watch);
  assert.equal(feedback.phase, phase);
  assert.equal(watch.page.noticeText.props.visible, true);
  assert.equal(watch.page.noticeText.props.text, feedback.text);
  if (text) assert.match(feedback.text, text);
  return feedback;
}

// Keep this test synchronous between touch-up and the assertions: waiting for
// a phone reply before showing recognition would recreate the reported lag.
test('swipe recognition is visible immediately on release while its request is unresolved', async t => {
  const w = await ready(t);
  w.touch('down', 260, 230); w.touch('move', 160, 230, 20);
  assert.equal(snapshot(w), null);
  w.touch('up', 160, 230, 40);
  const feedback = visibleFeedback(w, 'sending', /^Swipe left\nSending · 0s$/);
  assert.equal(commands(w).length, 1);
  assert.equal(commands(w)[0].requestId, feedback.id);
  assert.equal(commands(w)[0].operation.gesture, 'swipe-left');
  assert.equal(w.page.busy, true);
});

test('elapsed progress, correlated phone receipt and acceptance identify the same command', async t => {
  const w = await ready(t); swipeLeft(w);
  const id = snapshot(w).id;
  w.advance(1200); visibleFeedback(w, 'sending', /Sending · 1s$/);
  receipt(w, id); visibleFeedback(w, 'phone-received', /Phone received · 1s$/);
  await w.reply({ ok: true });
  const result = visibleFeedback(w, 'accepted', /Faceclaw accepted · 1\.2s$/);
  assert.equal(result.id, id); assert.equal(result.pending, false);
  assert.doesNotMatch(result.text, /shown|displayed|rendered/i);
  assert.equal(w.calls.at(-1).kind, 'state');
});

test('status replies and ordinary notice updates cannot overwrite current command feedback', async t => {
  const w = await ready(t); swipeLeft(w);
  await w.reply({ ok: true });
  const result = snapshot(w);
  await w.reply({ ok: true, state: { ...sampleState, foreground: { appId: 'notes', title: 'Notes' } } });
  assert.equal(w.page.padTitle.props.text, 'Notes');
  assert.deepEqual(snapshot(w), result); assert.equal(w.page.noticeText.props.text, result.text);
  w.page.setNotice('Ordinary status message');
  assert.deepEqual(snapshot(w), result); assert.equal(w.page.noticeText.props.text, result.text);
});

test('wrong, older, malformed and late receipts never replace newer or terminal feedback', async t => {
  const w = await ready(t); swipeLeft(w);
  const oldId = snapshot(w).id;
  await w.reply({ ok: true }); await w.reply();
  w.page.gesture('double-click'); const id = snapshot(w).id;
  receipt(w, oldId); receipt(w, 'fc-wrong-1'); receipt(w, id, 'unsupported');
  w.page.onCall({ method: 'OTHER', params: { requestId: id, stage: 'phone-received' } });
  w.page.onCall({ method: 'FACECLAW_PROGRESS', params: null });
  w.page.onCall(null);
  visibleFeedback(w, 'sending', /^Double tap\n/);
  receipt(w, id); visibleFeedback(w, 'phone-received', /^Double tap\n/);
  await w.reply({ ok: true }); const terminal = snapshot(w);
  receipt(w, id); receipt(w, oldId);
  assert.deepEqual(snapshot(w), terminal);
});

test('a busy swipe reports that it was not sent and the older success cannot accept it', async t => {
  const w = await ready(t); w.page.gesture('click');
  const oldId = snapshot(w).id;
  swipeLeft(w); const blocked = visibleFeedback(w, 'blocked', /^Swipe left\nBusy · Not sent$/);
  assert.notEqual(blocked.id, oldId); assert.equal(commands(w).length, 1);
  receipt(w, oldId); assert.deepEqual(snapshot(w), blocked);
  await w.reply({ ok: true }); assert.deepEqual(snapshot(w), blocked);
  await w.reply(); assert.deepEqual(snapshot(w), blocked);
});

test('busy status polling, dark glasses, locks and unavailable control give visible blocking feedback', async t => {
  const polling = await ready(t); polling.page.refresh();
  swipeLeft(polling); visibleFeedback(polling, 'blocked', /Busy · Not sent/);
  assert.equal(commands(polling).length, 0);
  await polling.reply(); visibleFeedback(polling, 'blocked', /Busy · Not sent/);
  for (const [patch, detail] of [
    [{ screenOn: false }, /Double tap to wake/], [{ locked: true }, /Glasses are locked/],
    [{ screenOn: false, locked: true }, /Glasses are locked/],
    [{ remoteEnabled: false }, /Watch control is off/], [{ connected: false }, /Glasses disconnected/],
  ]) {
    const w = await ready(t, { ...sampleState, ...patch });
    swipeLeft(w); visibleFeedback(w, 'blocked', detail);
    assert.equal(commands(w).length, 0);
  }
});

test('dark-display wake gestures and locked double-tap remain available', async t => {
  for (const [patch, gesture] of [
    [{ screenOn: false }, 'click'], [{ screenOn: false }, 'double-click'], [{ screenOn: false }, 'long-press'],
    [{ locked: true }, 'double-click'], [{ screenOn: false, locked: true }, 'double-click'],
  ]) {
    const w = await ready(t, { ...sampleState, ...patch });
    w.page.gesture(gesture);
    visibleFeedback(w, 'sending'); assert.equal(commands(w).length, 1);
    assert.equal(commands(w)[0].operation.gesture, gesture);
  }
});

test('known ignored taps and holds on locked glasses report blocked without sending', async t => {
  for (const gesture of ['click', 'long-press', 'short-then-long-press']) {
    const w = await ready(t, { ...sampleState, locked: true });
    w.page.gesture(gesture);
    visibleFeedback(w, 'blocked', /Glasses are locked/);
    assert.equal(commands(w).length, 0);
  }
});

test('an expired queued crown step stays visibly skipped after the older command succeeds', async t => {
  const w = await ready(t); w.crown(-24, 10);
  const sentId = snapshot(w).id;
  w.crown(24, 300); const waiting = visibleFeedback(w, 'queued', /^Scroll down\nWaiting · 0s$/);
  assert.notEqual(waiting.id, sentId); assert.equal(commands(w).length, 1);
  receipt(w, sentId); assert.equal(snapshot(w).phase, 'queued');
  w.advance(351); const skipped = visibleFeedback(w, 'skipped', /^Scroll down\nTurn crown again$/);
  assert.equal(w.page.pendingCrown, null); assert.equal(w.page.pendingCrownTimer, null);
  await w.reply({ ok: true }); receipt(w, sentId); receipt(w, waiting.id);
  assert.deepEqual(snapshot(w), skipped); assert.equal(commands(w).length, 1);
});

test('only the newest queued crown intent can be sent or accepted', async t => {
  const w = await ready(t); w.crown(-24, 10); const firstId = snapshot(w).id;
  w.crown(-24, 300); const replacedId = snapshot(w).id;
  w.crown(24, 10); const newestId = snapshot(w).id;
  assert.notEqual(newestId, replacedId); receipt(w, replacedId); receipt(w, firstId);
  visibleFeedback(w, 'queued', /^Scroll down\n/);
  await w.reply({ ok: true });
  assert.equal(commands(w).length, 2); assert.equal(commands(w)[1].requestId, newestId);
  visibleFeedback(w, 'sending', /^Scroll down\n/);
  receipt(w, firstId); receipt(w, replacedId); assert.equal(snapshot(w).phase, 'sending');
  receipt(w, newestId); visibleFeedback(w, 'phone-received');
  await w.reply({ ok: true });
  assert.equal(snapshot(w).id, newestId); visibleFeedback(w, 'accepted', /^Scroll down\n/);
});

test('timeout is visibly unknown and status recovery never retries the gesture', async t => {
  const w = await ready(t); swipeLeft(w); const id = snapshot(w).id;
  await w.reject('request timeout');
  const unknown = visibleFeedback(w, 'unknown', /^Swipe left\nResult unknown$/);
  assert.equal(unknown.error, true); assert.equal(commands(w).length, 1);
  receipt(w, id); assert.deepEqual(snapshot(w), unknown);
  await w.reply(); assert.deepEqual(snapshot(w), unknown);
  w.advance(3000); await w.reply();
  assert.equal(commands(w).length, 1); assert.equal(snapshot(w).phase, 'unknown');
});

test('sleep, navigation and exit clear progress and ignore late successful gesture events', async t => {
  for (const [kind, cancel] of [
    ['sleep', w => w.screen(2)], ['navigate', w => w.page.navigate('apps')], ['exit', w => w.key(8)],
  ]) {
    const w = await ready(t); swipeLeft(w); const id = snapshot(w).id;
    cancel(w); assert.equal(snapshot(w), null, kind);
    receipt(w, id); assert.equal(snapshot(w), null, kind);
    await w.reply({ ok: true }); receipt(w, id);
    assert.equal(snapshot(w), null, kind); assert.equal(w.page.notice, '', kind);
    if (kind !== 'exit') assert.equal(w.page.noticeText.props.visible, false, kind);
    assert.equal(commands(w).length, 1, kind);
    if (kind === 'exit') assert.equal(w.timers.size, 0);
  }
});

test('navigation after an app request prevents its late success from changing the screen or reviving a notice', async t => {
  const w = await ready(t); w.page.navigate('apps'); await w.reply(); w.page.select(3); w.page.activate();
  const id = snapshot(w).id;
  assert.equal(commands(w)[0].operation.command, 'launch-app');
  w.page.navigate('status'); assert.equal(snapshot(w), null);
  await w.reply({ ok: true, message: 'Launched Timer' }); receipt(w, id);
  assert.equal(w.page.screen, 'status'); assert.equal(snapshot(w), null);
  assert.equal(w.page.notice, ''); assert.equal(w.page.noticeText.props.visible, false);
});

test('sleep and wake do not revive a previously cleared app result', async t => {
  const w = await ready(t); w.page.navigate('apps'); await w.reply(); w.page.select(3); w.page.activate();
  const id = snapshot(w).id; w.screen(2); w.screen(1);
  await w.reply({ ok: true, message: 'Launched Timer' }); receipt(w, id);
  assert.equal(snapshot(w), null); assert.equal(w.page.screen, 'apps');
  assert.equal(w.page.notice, ''); assert.equal(w.page.noticeText.props.visible, false);
});

test('an error from a command cleared by navigation cannot resurrect a progress notice', async t => {
  const w = await ready(t); swipeLeft(w); const id = snapshot(w).id;
  w.page.navigate('apps'); await w.reject('request timeout'); receipt(w, id);
  assert.equal(snapshot(w), null); assert.equal(w.page.screen, 'apps');
  assert.equal(w.page.notice, ''); assert.equal(w.page.noticeText.props.visible, false);
  assert.equal(commands(w).length, 1);
});


test('transport loss or a malformed reply after phone receipt is unknown rather than rejected', async t => {
  for (const complete of [
    w => w.reject('ble disconnect'), w => w.reply(null), w => w.reply({ message: 'not a valid response' }),
  ]) {
    const w = await ready(t); swipeLeft(w); const id = snapshot(w).id;
    receipt(w, id); visibleFeedback(w, 'phone-received');
    await complete(w);
    visibleFeedback(w, 'unknown', /Result unknown$/);
    receipt(w, id); assert.equal(snapshot(w).phase, 'unknown');
    assert.equal(commands(w).length, 1);
  }
});

test('an explicit rejection remains visibly distinct from an unknown transport result', async t => {
  const w = await ready(t); swipeLeft(w); const id = snapshot(w).id;
  receipt(w, id);
  await w.reply({ ok: false, error: 'Glasses unavailable' });
  visibleFeedback(w, 'failed', /^Swipe left\nNot accepted$/);
  assert.equal(commands(w).length, 1);
});

test('sleep and wake before an old timeout cannot revive its command feedback or notice', async t => {
  const w = await ready(t); swipeLeft(w); const id = snapshot(w).id;
  receipt(w, id); w.screen(2); w.screen(1);
  await w.reject('request timeout'); receipt(w, id);
  assert.equal(snapshot(w), null); assert.equal(w.page.notice, '');
  assert.equal(w.page.noticeText.props.visible, false); assert.equal(commands(w).length, 1);
});

test('local tray swipes do not display remote progress or send a glasses command', async t => {
  const w = await ready(t);
  w.touch('down', 240, 440); w.touch('move', 240, 340, 20); w.touch('up', 240, 340, 40);
  assert.equal(w.page.tray, true); assert.equal(snapshot(w), null); assert.equal(commands(w).length, 0);
  w.touch('down', 240, 370); w.touch('move', 240, 440, 20); w.touch('up', 240, 440, 40);
  assert.equal(w.page.tray, false); assert.equal(snapshot(w), null); assert.equal(commands(w).length, 0);
});


test('sleep clears terminal command notices as well as feedback, and wake keeps them cleared', async t => {
  for (const result of [
    { ok: false, error: 'Glasses unavailable' }, { ok: true, message: 'Opened Timer' },
  ]) {
    const w = await ready(t); w.page.navigate('apps'); await w.reply(); w.page.select(3); w.page.activate();
    await w.reply(result); await w.reply();
    assert.notEqual(w.page.notice, '');
    w.screen(2);
    assert.equal(snapshot(w), null); assert.equal(w.page.notice, '');
    assert.equal(w.page.noticeText.props.visible, false);
    w.screen(1); await w.reply();
    assert.equal(snapshot(w), null); assert.equal(w.page.notice, ''); assert.equal(w.page.noticeText.props.visible, false);
  }
});
