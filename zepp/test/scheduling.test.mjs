import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleState, watchFixture } from './fixture.mjs';

async function ready(t, state = sampleState) {
  const w = watchFixture(); t.after(() => w.page.onDestroy());
  // Test manual input after activity has superseded opening-time auto-wake.
  if (!state.screenOn) w.page.noteActivity();
  await w.reply({ ok: true, state });
  return w;
}
async function apps(t) {
  const w = await ready(t); w.page.navigate('apps'); await w.reply(); return w;
}
const commands = w => w.requests.filter(request => request.operation.kind !== 'state');
const reads = w => w.requests.filter(request => request.operation.kind === 'state');
const feedback = w => w.page.commandFeedback.snapshot();
function swipe(w, direction = 'left') {
  const end = { left: [140, 230], right: [340, 230], up: [240, 130], down: [240, 330] }[direction];
  w.touch('down', 240, 230); w.touch('move', ...end, 20); w.touch('up', ...end, 40);
}
function assertQueued(w) {
  const result = feedback(w);
  assert.equal(result.phase, 'queued'); assert.equal(result.pending, true);
  assert.equal(w.page.noticeText.props.visible, true); assert.equal(w.page.noticeText.props.text, result.text);
  return result;
}
function assertNotSent(w) {
  assert.equal(commands(w).length, 0);
  const result = feedback(w);
  assert.ok(result); assert.equal(result.pending, false); assert.notEqual(result.phase, 'accepted');
  assert.equal(w.page.noticeText.props.visible, true);
}

test('successful directional gestures skip the immediate status read and retain the idle poll', async t => {
  for (const gesture of ['swipe-up', 'swipe-down', 'swipe-left', 'swipe-right', 'scroll-up', 'scroll-down']) {
    const w = await ready(t); w.page.gesture(gesture);
    await w.reply({ ok: true });
    assert.equal(commands(w).length, 1, gesture); assert.equal(reads(w).length, 1, gesture);
    w.advance(2999); assert.equal(reads(w).length, 1, gesture);
    w.advance(1); assert.equal(reads(w).length, 2, gesture);
  }
});

test('tap, double-tap and hold gestures retain their immediate state refresh', async t => {
  for (const gesture of ['click', 'double-click', 'long-press', 'short-then-long-press']) {
    const w = await ready(t); w.page.gesture(gesture); await w.reply({ ok: true });
    assert.equal(commands(w).length, 1, gesture); assert.equal(reads(w).length, 2, gesture);
    assert.equal(w.calls.at(-1).kind, 'state', gesture);
  }
});

test('an idle poll does not start during a held touch, including after motion', async t => {
  const w = await ready(t); w.advance(2900); w.touch('down', 240, 230);
  w.advance(3000); assert.equal(reads(w).length, 1);
  w.touch('move', 242, 231); w.advance(3000); assert.equal(reads(w).length, 1);
  w.touch('up', 242, 231);
  assert.equal(commands(w).length, 1); assert.equal(commands(w)[0].operation.gesture, 'long-press');
  await w.reply({ ok: true }); assert.equal(reads(w).length, 2);
});

test('the 300ms single-tap recognition delay is not interrupted by an idle poll', async t => {
  const w = await ready(t); w.advance(2900);
  w.touch('down', 240, 230); w.touch('up', 240, 230, 50);
  w.advance(100); assert.equal(reads(w).length, 1); assert.equal(commands(w).length, 0);
  w.advance(199); assert.equal(reads(w).length, 1); assert.equal(commands(w).length, 0);
  w.advance(1);
  assert.equal(reads(w).length, 1); assert.equal(commands(w).length, 1);
  assert.equal(commands(w)[0].operation.gesture, 'click'); assert.equal(feedback(w).phase, 'sending');
});

test('touch cancellation releases polling after a fresh idle interval', async t => {
  const w = await ready(t); w.advance(2900); w.touch('down', 240, 230);
  w.advance(300); assert.equal(reads(w).length, 1); // Cancel before it becomes a hold.
  w.touch('cancel', 240, 230); w.advance(2999); assert.equal(reads(w).length, 1);
  w.advance(1); assert.equal(reads(w).length, 2); assert.equal(commands(w).length, 0);
});

test('raw sub-threshold crown movement postpones an idle poll without sending a gesture', async t => {
  const w = await ready(t); w.advance(2900); w.crown(-1, 0);
  w.advance(200); assert.equal(reads(w).length, 1); assert.equal(commands(w).length, 0);
  w.advance(2800); assert.equal(reads(w).length, 2); assert.equal(commands(w).length, 0);
});

test('local list selection and local key navigation reset the idle poll interval', async t => {
  const list = await apps(t); const readCount = reads(list).length;
  list.advance(2900); list.page.select(1); list.advance(200); assert.equal(reads(list).length, readCount);
  list.advance(2800); assert.equal(reads(list).length, readCount + 1); assert.equal(commands(list).length, 0);
  const help = await ready(t); help.page.navigate('help'); help.advance(2900); help.key();
  assert.equal(help.page.screen, 'remote'); help.advance(200); assert.equal(reads(help).length, 1);
  help.advance(2800); assert.equal(reads(help).length, 2); assert.equal(commands(help).length, 0);
});

test('one swipe waits behind a state read and sends once after the fresh state is applied', async t => {
  const w = await ready(t); w.page.refresh(); swipe(w);
  const queued = assertQueued(w); assert.equal(commands(w).length, 0);
  await w.reply();
  assert.equal(commands(w).length, 1); assert.equal(commands(w)[0].operation.gesture, 'swipe-left');
  assert.equal(commands(w)[0].requestId, queued.id); assert.equal(feedback(w).phase, 'sending');
  await w.reply({ ok: true }); assert.equal(commands(w).length, 1); assert.equal(reads(w).length, 2);
});

test('a recognized tap may wait behind a read and still refreshes after its one send', async t => {
  const w = await ready(t); w.page.refresh();
  w.touch('down', 240, 230); w.touch('up', 240, 230, 50); w.advance(300);
  const queued = assertQueued(w); await w.reply();
  assert.equal(commands(w).length, 1); assert.equal(commands(w)[0].operation.gesture, 'click');
  assert.equal(commands(w)[0].requestId, queued.id);
  await w.reply({ ok: true }); assert.equal(reads(w).length, 3); assert.equal(commands(w).length, 1);
});

test('an unsent action expires visibly after one second and a late state reply cannot send it', async t => {
  const w = await ready(t); w.page.refresh(); swipe(w); const id = assertQueued(w).id;
  w.advance(1001); assertNotSent(w); assert.equal(feedback(w).id, id);
  await w.reply(); assertNotSent(w);
});

test('newest unsent action replaces the old one and has its own freshness deadline', async t => {
  const w = await ready(t); w.page.refresh(); swipe(w); const oldId = assertQueued(w).id;
  w.advance(700); swipe(w, 'up'); const newest = assertQueued(w); assert.notEqual(newest.id, oldId);
  w.advance(350); assert.equal(feedback(w).id, newest.id); assert.equal(feedback(w).phase, 'queued');
  await w.reply();
  assert.equal(commands(w).length, 1); assert.equal(commands(w)[0].requestId, newest.id);
  assert.equal(commands(w)[0].operation.gesture, 'swipe-up');
});

test('no user action queues behind an already sent mutation', async t => {
  const w = await ready(t); swipe(w); const sentId = commands(w)[0].requestId;
  swipe(w, 'up'); assert.equal(feedback(w).phase, 'blocked'); assert.equal(commands(w).length, 1);
  await w.reply({ ok: true });
  assert.equal(commands(w).length, 1); assert.equal(commands(w)[0].requestId, sentId);
  w.advance(1001); assert.equal(commands(w).length, 1);
});

test('fresh disabled, disconnected, dark or locked state cancels a queued swipe before sending', async t => {
  for (const patch of [{ remoteEnabled: false }, { connected: false }, { screenOn: false }, { locked: true }]) {
    const w = await ready(t); w.page.refresh(); swipe(w); assertQueued(w);
    await w.reply({ ok: true, state: { ...sampleState, ...patch } }); assertNotSent(w);
  }
});

test('queued gesture drops if the focused window changes, even within the same app', async t => {
  for (const state of [
    { ...sampleState, foreground: { appId: 'notes', title: 'Notes' }, windows: sampleState.windows.map(win => ({ ...win, focused: win.windowId === 'notes:2' })) },
    { ...sampleState, windows: [...sampleState.windows.map(win => ({ ...win, focused: false })),
      { windowId: 'music:second', appId: 'music', title: 'Music 2', focused: true, closeable: true }] },
  ]) {
    const w = await ready(t); w.page.refresh(); swipe(w); assertQueued(w);
    await w.reply({ ok: true, state }); assertNotSent(w);
  }
});

test('a queued wake double-tap cannot become Back when the read shows an already awake display', async t => {
  const w = await ready(t, { ...sampleState, screenOn: false }); w.page.refresh(); w.page.gesture('double-click');
  assertQueued(w); await w.reply(); assertNotSent(w);
});

test('queued launch keeps the exact app ID across a reordered app list', async t => {
  const w = await apps(t); w.page.select(4); w.page.refresh(); w.key(); const queued = assertQueued(w);
  await w.reply({ ok: true, state: { ...sampleState, apps: [sampleState.apps[2], sampleState.apps[0], sampleState.apps[1]] } });
  assert.equal(commands(w).length, 1); assert.equal(commands(w)[0].operation.command, 'launch-app');
  assert.equal(commands(w)[0].operation.appId, 'navigation'); assert.equal(commands(w)[0].requestId, queued.id);
  await w.reply({ ok: true }); assert.equal(w.calls.at(-1).kind, 'state');
});

test('queued close keeps the exact window ID across reordered windows', async t => {
  const w = await apps(t); w.page.select(1); w.page.refresh(); w.page.closeSelected(); const queued = assertQueued(w);
  await w.reply({ ok: true, state: { ...sampleState, windows: [sampleState.windows[0], sampleState.windows[2], sampleState.windows[1]] } });
  assert.equal(commands(w).length, 1); assert.equal(commands(w)[0].operation.command, 'close-window');
  assert.equal(commands(w)[0].operation.windowId, 'notes:2'); assert.equal(commands(w)[0].requestId, queued.id);
});

test('missing app or window and lost close permission cancel the captured action', async t => {
  for (const scenario of ['app missing', 'focus missing', 'close missing', 'close forbidden']) {
    const w = await apps(t); const launch = scenario === 'app missing';
    w.page.select(launch ? 4 : 1); w.page.refresh();
    if (scenario.startsWith('close')) w.page.closeSelected(); else w.key();
    assertQueued(w);
    const state = { ...sampleState };
    if (launch) state.apps = sampleState.apps.filter(app => app.appId !== 'navigation');
    else if (scenario === 'close forbidden') state.windows = sampleState.windows.map(win => win.windowId === 'notes:2' ? { ...win, closeable: false } : win);
    else state.windows = sampleState.windows.filter(win => win.windowId !== 'notes:2');
    await w.reply({ ok: true, state }); assertNotSent(w);
  }
});

test('touch-down and raw crown input cancel an older queued action before it can drain', async t => {
  for (const cancel of [w => w.touch('down', 240, 230), w => w.crown(-1, 0)]) {
    const w = await ready(t); w.page.refresh(); swipe(w); assertQueued(w); cancel(w);
    await w.reply(); assert.equal(commands(w).length, 0);
  }
});

test('local selection cancels an app intent queued for the previously selected row', async t => {
  const w = await apps(t); w.page.select(3); w.page.refresh(); w.key(); assertQueued(w);
  w.page.select(4); await w.reply(); assert.equal(commands(w).length, 0);
});

test('regular action and crown pending slots are mutually exclusive', async t => {
  const crownLast = await ready(t); crownLast.page.refresh(); swipe(crownLast); const swipeId = assertQueued(crownLast).id;
  crownLast.crown(-24, 10); const crownId = feedback(crownLast).id; assert.notEqual(crownId, swipeId);
  await crownLast.reply();
  assert.equal(commands(crownLast).length, 1); assert.equal(commands(crownLast)[0].operation.gesture, 'scroll-down');
  assert.equal(commands(crownLast)[0].requestId, crownId);
  const tapLast = await ready(t); tapLast.page.refresh(); tapLast.crown(-24, 10);
  tapLast.touch('down', 240, 230); tapLast.touch('up', 240, 230, 50); tapLast.advance(300);
  const tapId = assertQueued(tapLast).id; await tapLast.reply();
  assert.equal(commands(tapLast).length, 1); assert.equal(commands(tapLast)[0].operation.gesture, 'click');
  assert.equal(commands(tapLast)[0].requestId, tapId);
});

test('navigation, sleep, sleep-wake and exit cancel a queued action before a late read reply', async t => {
  for (const cancel of [
    w => { w.page.navigate('apps'); w.page.navigate('remote'); },
    w => w.screen(2), w => { w.screen(2); w.screen(1); }, w => w.key(8),
  ]) {
    const w = await ready(t); w.page.refresh(); swipe(w); const id = assertQueued(w).id;
    cancel(w); await w.reply();
    w.page.onCall({ method: 'FACECLAW_PROGRESS', params: { requestId: id, stage: 'phone-received' } });
    assert.equal(commands(w).length, 0); assert.equal(feedback(w), null);
  }
});

test('failed state reads discard queued input and a later successful refresh cannot replay it', async t => {
  const w = await ready(t); w.page.refresh(); swipe(w); assertQueued(w);
  await w.reject('status timeout'); assert.equal(commands(w).length, 0);
  assert.equal(feedback(w).pending, false);
  w.page.refresh(); await w.reply(); assert.equal(commands(w).length, 0);
});

test('initial and stale status cannot use the pending slot to bypass state freshness', async t => {
  const initial = watchFixture(); t.after(() => initial.page.onDestroy());
  swipe(initial); await initial.reply(); assert.equal(commands(initial).length, 0);
  const stale = await ready(t); stale.advance(15001); swipe(stale);
  assert.equal(commands(stale).length, 0); assert.notEqual(feedback(stale).phase, 'queued');
  await stale.reply(); assert.equal(commands(stale).length, 0);
});


test('fresh glasses lock cancels queued launch, focus and close actions before sending', async t => {
  for (const action of ['launch', 'focus', 'close']) {
    const w = await apps(t); w.page.select(action === 'launch' ? 4 : 1); w.page.refresh();
    if (action === 'close') w.page.closeSelected(); else w.key();
    assertQueued(w);
    await w.reply({ ok: true, state: { ...sampleState, locked: true } });
    assertNotSent(w); assert.match(feedback(w).text, /locked/i);
  }
});

test('queued launch and focus may still wake an unlocked display that became dark', async t => {
  for (const index of [4, 1]) {
    const w = await apps(t); w.page.select(index); w.page.refresh(); w.key(); assertQueued(w);
    await w.reply({ ok: true, state: { ...sampleState, screenOn: false } });
    assert.equal(commands(w).length, 1);
    assert.equal(commands(w)[0].operation.command, index === 4 ? 'launch-app' : 'focus-window');
  }
});

test('authorized queued lock, unlock, connect and disconnect remain available when applicable', async t => {
  for (const [patch, index, command] of [
    [{ locked: false }, 2, 'lock'], [{ locked: true, canUnlock: true }, 2, 'unlock'],
    [{ connected: false, locked: true }, 0, 'connect'], [{ connected: true, locked: true }, 0, 'disconnect'],
  ]) {
    const state = { ...sampleState, ...patch }, w = await ready(t, state);
    w.page.navigate('status'); await w.reply({ ok: true, state }); w.page.select(index); w.page.refresh(); w.key();
    assertQueued(w); await w.reply({ ok: true, state });
    assert.equal(commands(w).length, 1, command); assert.equal(commands(w)[0].operation.command, command);
  }
});

test('a changed status toggle or lost unlock permission never sends the old action', async t => {
  for (const [before, after, index] of [
    [{ connected: false }, { connected: true }, 0], [{ connected: true }, { connected: false }, 0],
    [{ screenOn: true }, { screenOn: false }, 1], [{ screenOn: false }, { screenOn: true }, 1],
    [{ locked: false }, { locked: true }, 2], [{ locked: true }, { locked: false }, 2],
    [{ locked: true, canUnlock: true }, { locked: true, canUnlock: false }, 2],
  ]) {
    const state = { ...sampleState, ...before }, w = await ready(t, state);
    w.page.navigate('status'); await w.reply({ ok: true, state }); w.page.select(index); w.page.refresh(); w.key();
    assertQueued(w); await w.reply({ ok: true, state: { ...state, ...after } }); assertNotSent(w);
  }
});
