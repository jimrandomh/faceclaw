import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrownNavigation, createTouchpad, appRows, moveSelection } from '../lib/model.js';
import { watchFixture, sampleState } from './fixture.mjs';

test('crown accumulates deliberate rotation, caps repeated turns and discards excess', () => {
  const crown = createCrownNavigation();
  assert.deepEqual([0, 20, 40, 60].map(t => crown.step(-6, t)), [0, 0, 0, 1]);
  for (let t = 80; t < 340; t += 20) assert.equal(crown.step(-120, t), 0);
  assert.equal(crown.step(-6, 340), 0); assert.equal(crown.step(-18, 360), 1);
  assert.equal(crown.step(-720, 800), 1);
  assert.equal(crown.step(24, 820), -1); // Immediate deliberate reversal.
  crown.reset(); assert.equal(crown.step(-18, 900), 0); assert.equal(crown.step(-6, 1300), 0);
  for (const value of [NaN, Infinity, 0, '24']) assert.equal(crown.step(value, 1400), 0);
});

test('discarding input while phone is busy retains the repeat-rate limit', () => {
  const crown = createCrownNavigation();
  assert.equal(crown.step(-24, 1000), 1); crown.clearPending();
  assert.equal(crown.step(-24, 1100), 0);
  assert.equal(crown.step(-24, 1300), 1);
});

test('window identity and app identity remain distinct, close only exists for closeable windows', () => {
  const rows = appRows(sampleState);
  assert.deepEqual(rows.map(r => r.section), ['On screen', 'Also open', 'Also open', 'Launch', 'Launch', 'Launch']);
  assert.equal(rows[0].operation.windowId, 'music:1'); assert.equal(rows[0].close.command, 'close-window');
  assert.equal(rows[2].close, null); assert.equal(rows[3].close, null);
  assert.equal(moveSelection(0, 0, 1), 0); assert.equal(moveSelection(5, 6, 1), 5);
});

test('touchpad disambiguates select, double-tap, hold, short-then-long, swipes and drift', () => {
  const emitted = [], timers = new Map(); let id = 0;
  const pad = createTouchpad((gesture, detail) => emitted.push({ gesture, detail }), { setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: id => timers.delete(id) });
  const flush = () => { const work = [...timers.values()]; timers.clear(); work.forEach(fn => fn()); };
  pad.down(200, 200, 0); pad.up(200, 200, 50); assert.equal(emitted.length, 0); flush();
  pad.down(200, 200, 1000); pad.up(200, 200, 1050); pad.down(200, 200, 1150); pad.up(200, 200, 1200); flush();
  pad.down(200, 200, 2000); pad.up(200, 200, 2800);
  pad.down(200, 200, 3000); pad.up(200, 200, 3050); pad.down(200, 200, 3150); pad.up(200, 200, 4000); flush();
  pad.down(200, 440, 5000); pad.move(200, 300); pad.up(200, 300, 5200);
  pad.down(100, 200, 6000); pad.move(200, 200); pad.up(200, 200, 6200);
  pad.down(200, 200, 7000); pad.move(250, 200); pad.up(200, 200, 7200); flush();
  assert.deepEqual(emitted.map(e => e.gesture), ['click', 'double-click', 'long-press', 'short-then-long-press', 'swipe-up', 'swipe-right']);
  assert.equal(emitted[4].detail.startY, 440);
  pad.down(200, 200, 8000); pad.up(200, 200, 8050); pad.reset(); flush(); assert.equal(emitted.length, 6);
});

test('phone status stays separate from framework-owned page state', async () => {
  const w = watchFixture({ fixedFrameworkState: true });
  const frameworkState = w.page.state, messaging = frameworkState.messaging;
  try {
    assert.equal(w.page.padTitle.props.text, 'Connecting…');
    assert.equal(w.calls.length, 1); assert.equal(w.calls[0].kind, 'state');
    await w.reply();
    assert.equal(w.page.padTitle.props.text, 'Music');
    w.crown();
    assert.equal(w.calls.length, 2); assert.equal(w.calls[1].kind, 'gesture');
    assert.equal(w.calls[1].gesture, 'scroll-up');
    await w.reply({ ok: true });
    w.page.refresh();
    await w.reply({ ok: true, state: { ...sampleState, remoteEnabled: false } });
    assert.equal(w.page.padTitle.props.text, 'Watch control off');
    const callCount = w.calls.length;
    w.page.gesture('click');
    assert.equal(w.calls.length, callCount);
    assert.equal(w.page.state, frameworkState);
    assert.equal(w.page.state.messaging, messaging);
    assert.deepEqual(Object.keys(frameworkState), ['messaging']);
  } finally { w.page.onDestroy(); }
});

test('opening watch and browsing apps sends no launch until a single crown press', async () => {
  const w = watchFixture(); await w.reply();
  assert.equal(w.page.screen, 'remote'); assert.equal(w.calls.length, 1); assert.equal(w.calls[0].kind, 'state');
  w.page.navigate('apps'); await w.reply();
  for (let i = 0; i < 4; i++) w.crown();
  assert.equal(w.page.selected, 4); assert.equal(w.calls.length, 2);
  assert.equal(w.key(), true); w.key();
  assert.equal(w.calls.length, 3); assert.equal(w.calls[2].command, 'launch-app'); assert.equal(w.calls[2].appId, 'navigation');
  await w.reply({ ok: true, message: 'Launched Navigation' });
  assert.equal(w.page.screen, 'remote'); assert.equal(w.calls[3].kind, 'state');
  await w.reply(); w.page.onDestroy();
});

test('close targets the selected window exactly once, stays on list, preserves selection by ID', async () => {
  const w = watchFixture(); await w.reply(); w.page.navigate('apps'); await w.reply(); w.crown();
  w.page.closeSelected(); w.page.closeSelected(); w.key();
  assert.equal(w.calls.filter(c => c.command === 'close-window').length, 1); assert.equal(w.calls.at(-1).windowId, 'notes:2');
  await w.reply({ ok: true, message: 'Closed' });
  await w.reply({ ok: true, state: { ...sampleState, windows: sampleState.windows.filter(win => win.windowId !== 'notes:2') } });
  assert.equal(w.page.screen, 'apps'); assert.equal(w.page.rows[w.page.selected].key, 'w:launcher:1');
  w.page.closeSelected(); assert.equal(w.calls.length, 4); w.page.onDestroy();
});

test('timeout result is unknown, refreshing never replays a command', async () => {
  const w = watchFixture(); await w.reply(); w.page.gesture('double-click');
  await w.reject('timeout'); assert.match(w.page.notice, /Result unknown/);
  assert.equal(w.calls.filter(c => c.kind === 'gesture').length, 1);
  assert.equal(w.calls.at(-1).kind, 'state'); await w.reply();
  w.advance(4000); await w.reply(); assert.equal(w.calls.filter(c => c.kind === 'gesture').length, 1); w.page.onDestroy();
});

test('screen off cancels polling and inputs; waking refreshes without emitting a click', async () => {
  const w = watchFixture(); await w.reply(); w.screen(2); w.advance(10000); w.crown();
  assert.equal(w.calls.length, 1); w.screen(1); assert.equal(w.calls.length, 2); assert.equal(w.calls[1].kind, 'state');
  await w.reply(); w.page.onDestroy(); w.advance(10000); assert.equal(w.calls.length, 2);
});

test('exiting while a command is pending sends no follow-up', async () => {
  const w = watchFixture(); await w.reply(); w.page.gesture('click'); w.page.onDestroy(); await w.reply({ ok: true });
  w.advance(20000); assert.equal(w.calls.length, 2);
});

test('crown on pad respects direction and rate limit without an extra status roundtrip', async () => {
  const w = watchFixture(); await w.reply();
  w.crown(-24, 10); assert.equal(w.calls.at(-1).gesture, 'scroll-up');
  await w.reply({ ok: true }); assert.equal(w.calls.length, 2);
  w.crown(-720, 50); assert.equal(w.calls.length, 2);
  w.crown(-24, 300); assert.equal(w.calls.at(-1).gesture, 'scroll-up');
  await w.reply({ ok: true });
  w.page.refresh(); await w.reply({ ok: true, state: { ...sampleState, crownClockwiseNext: true } });
  w.crown(-24, 300); assert.equal(w.calls.at(-1).gesture, 'scroll-down');
  w.page.onDestroy(); await w.reply({ ok: true });
});

test('local crown, swipe and neighbor selection work during polls and retain the latest identity', async () => {
  const w = watchFixture(); await w.reply(); w.page.navigate('apps');
  w.page.rowButtons[2].props.click_func(); assert.equal(w.page.selected, 1);
  w.gesture(5); assert.equal(w.page.selected, 2);
  w.crown(); assert.equal(w.page.rows[w.page.selected].key, 'a:timer');
  assert.equal(w.calls.length, 2); // Only the initial state and the Apps refresh.
  await w.reply({ ok: true, state: { ...sampleState, windows: [...sampleState.windows,
    { windowId: 'new:1', title: 'New window', appId: 'notes', focused: false, closeable: true }] } });
  assert.equal(w.page.rows[w.page.selected].key, 'a:timer'); assert.equal(w.page.selected, 4);
  w.page.onDestroy();
});

test('a status poll does not discard a partly turned local crown', async () => {
  const w = watchFixture(); await w.reply(); w.page.navigate('apps'); await w.reply();
  w.crown(-18, 100); assert.equal(w.page.selected, 0);
  w.page.refresh(); w.crown(-6, 100); assert.equal(w.page.selected, 1);
  await w.reply(); assert.equal(w.page.selected, 1); w.page.onDestroy();
});

test('busy crown input keeps one latest direction without a backlog or per-step status read', async () => {
  const w = watchFixture(); await w.reply();
  w.crown(-24, 10);
  w.crown(-24, 300); w.crown(-720, 300); w.crown(24, 10);
  assert.equal(w.calls.length, 2);
  await w.reply({ ok: true });
  assert.equal(w.calls.length, 3); assert.equal(w.calls.at(-1).gesture, 'scroll-down');
  await w.reply({ ok: true }); assert.equal(w.calls.length, 3);
  w.advance(3000); assert.equal(w.calls.at(-1).kind, 'state');
  await w.reply(); assert.equal(w.calls.filter(call => call.kind === 'gesture').length, 2);
  w.page.onDestroy();
});

test('a fresh crown step waits for the state reply before it is sent', async () => {
  const w = watchFixture(); await w.reply(); w.page.refresh();
  w.crown(-24, 10); assert.equal(w.calls.length, 2);
  await w.reply(); assert.equal(w.calls.length, 3); assert.equal(w.calls.at(-1).gesture, 'scroll-up');
  await w.reply({ ok: true }); assert.equal(w.calls.length, 3); w.page.onDestroy();
});

test('queued crown input expires after 350ms without continued rotation', async () => {
  const w = watchFixture(); await w.reply(); w.page.refresh(); w.crown(-24, 10);
  w.advance(351); await w.reply();
  assert.equal(w.calls.length, 2); assert.equal(w.page.pendingCrown, null); w.page.onDestroy();
});

test('applied disabled, disconnected, sleeping or locked state cancels queued crown input', async () => {
  for (const patch of [{ remoteEnabled: false }, { connected: false }, { screenOn: false }, { locked: true }]) {
    const w = watchFixture(); await w.reply(); w.page.refresh(); w.crown(-24, 10);
    await w.reply({ ok: true, state: { ...sampleState, ...patch } });
    assert.equal(w.calls.length, 2); assert.equal(w.page.pendingCrown, null); w.page.onDestroy();
  }
});

test('a failed or timed-out crown request drops pending input and only refreshes', async () => {
  for (const reason of ['timeout', 'Phone unavailable']) {
    const w = watchFixture(); await w.reply(); w.crown(-24, 10); w.crown(-24, 300);
    await w.reject(reason);
    assert.equal(w.calls.length, 3); assert.equal(w.calls.at(-1).kind, 'state');
    await w.reply(); assert.equal(w.calls.length, 3);
    assert.equal(w.calls.filter(call => call.kind === 'gesture').length, 1); w.page.onDestroy();
  }
});

test('non-scroll interactions cancel pending crown input and actions never queue it', async () => {
  const w = watchFixture(); await w.reply(); w.crown(-24, 10); w.crown(-24, 300);
  w.page.gesture('click'); await w.reply({ ok: true });
  assert.equal(w.calls.length, 2); // The click was not queued behind the scroll.
  w.page.gesture('click'); w.crown(-24, 300); await w.reply({ ok: true }); await w.reply();
  assert.deepEqual(w.calls.filter(call => call.kind === 'gesture').map(call => call.gesture), ['scroll-up', 'click']);
  w.page.onDestroy();
});

test('navigation, watch sleep and exit discard queued crown input', async () => {
  for (const cancel of [w => w.page.navigate('apps'), w => w.screen(2), w => w.key(8)]) {
    const w = watchFixture(); await w.reply(); w.page.refresh(); w.crown(-24, 10);
    cancel(w); await w.reply();
    assert.equal(w.calls.length, 2); assert.equal(w.page.pendingCrown, null); w.page.onDestroy();
  }
});

test('stale phone status cannot send or queue crown input before a fresh reply', async () => {
  const w = watchFixture(); await w.reply(); w.advance(15001); w.crown(-24, 10);
  assert.equal(w.calls.length, 2); assert.equal(w.calls.at(-1).kind, 'state');
  await w.reply(); assert.equal(w.calls.length, 2);
  w.crown(-24, 300); assert.equal(w.calls.at(-1).gesture, 'scroll-up');
  w.page.onDestroy(); await w.reply({ ok: true });
});

test('disabled remote and disconnected state do not send app or gesture commands', async () => {
  const w = watchFixture(); await w.reply({ ok: true, state: { ...sampleState, remoteEnabled: false } });
  w.page.gesture('click'); assert.equal(w.calls.length, 1);
  w.page.navigate('apps'); await w.reply({ ok: true, state: { ...sampleState, connected: false } });
  w.key(); assert.equal(w.calls.length, 2); w.page.onDestroy();
});

test('connection details keep the full setup error readable and Retry sends only state', async () => {
  const w = watchFixture(); await w.reply({ ok: false, error: 'Add your input token in Zepp → Faceclaw Remote settings.' });
  w.page.reveal.props.click_func(); assert.equal(w.page.screen, 'details');
  assert.match(w.page.errorDetails.props.text, /Faceclaw Remote settings/);
  w.key(); assert.equal(w.calls.at(-1).kind, 'state'); await w.reply();
  assert.equal(w.page.screen, 'remote'); assert.equal(w.page.linkError, ''); w.page.onDestroy();
});

test('lower side button quits offline and busy, leaves the watch only, and cancels delayed sends', async () => {
  for (const error of ['Add your input token in Zepp settings.', 'Open Faceclaw on the phone.']) {
    const w = watchFixture(); await w.reply({ ok: false, error });
    assert.equal(w.key(8), true);
    assert.equal(w.exits(), 1); assert.equal(w.page.alive, false);
    w.advance(20000); assert.equal(w.calls.length, 1); w.page.onDestroy();
  }
  const pending = watchFixture(); await pending.reply(); pending.page.gesture('click');
  assert.equal(pending.page.busy, true);
  pending.key(8); pending.key(8);
  await pending.reply({ ok: true }); pending.advance(20000);
  assert.equal(pending.exits(), 1); assert.equal(pending.calls.length, 2);
  assert.equal(pending.calls.some(call => call.command === 'close-window'), false);
  const tapping = watchFixture(); await tapping.reply();
  tapping.touch('down', 240, 220); tapping.touch('up', 240, 220, 50);
  tapping.key(8); tapping.advance(20000);
  assert.equal(tapping.exits(), 1); assert.equal(tapping.calls.length, 1);
});

test('SHORTCUT and BACK quit from every screen without any on-screen Exit button', async () => {
  for (const key of [8, 3]) for (const screen of ['remote', 'apps', 'status', 'details', 'help']) {
    const w = watchFixture(); await w.reply();
    w.page.screen = screen; w.page.render();
    assert.equal(w.widgets.some(widget => widget.type === 'button' && widget.props.text === 'Exit'), false);
    assert.equal(w.key(key, 99), false); assert.equal(w.exits(), 0); // Only a single click is an exit.
    assert.equal(w.key(key), true); assert.equal(w.exits(), 1);
    w.advance(20000); assert.equal(w.calls.length, 1); w.page.onDestroy();
  }
});

test('HOME and SELECT remain activation keys and never quit', async () => {
  for (const key of [1, 2]) {
    const w = watchFixture(); await w.reply(); w.page.navigate('apps'); await w.reply(); w.page.select(3);
    assert.equal(w.key(key), true); assert.equal(w.calls.at(-1).command, 'launch-app');
    assert.equal(w.calls.at(-1).appId, 'timer'); assert.equal(w.exits(), 0);
    w.page.onDestroy(); await w.reply({ ok: true });
  }
});
