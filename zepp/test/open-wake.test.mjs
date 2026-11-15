import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleState, watchFixture } from './fixture.mjs';

const dark = { ...sampleState, screenOn: false };
const mutations = w => w.requests.filter(request => request.operation.kind !== 'state');
const wakes = w => mutations(w).filter(request => request.operation.command === 'wake');
function watch(t) { const w = watchFixture(); t.after(() => w.page.onDestroy()); return w; }

test('opening with connected, unlocked, dark glasses sends one explicit wake after fresh state', async t => {
  const w = watch(t); assert.equal(mutations(w).length, 0);
  await w.reply({ ok: true, state: { ...dark } });
  assert.equal(wakes(w).length, 1); assert.equal(mutations(w).length, 1);
  assert.equal(w.page.commandFeedback.snapshot().text.split('\n')[0], 'Wake glasses');
  await w.reply({ ok: true }); assert.equal(w.requests.at(-1).operation.kind, 'state');
  await w.reply({ ok: true, state: { ...sampleState } });
  w.advance(3000); await w.reply({ ok: true, state: { ...dark } });
  assert.equal(wakes(w).length, 1, 'later sleeping display never triggers another automatic wake');
});

test('already on, disabled, disconnected or locked glasses never auto-wake', async t => {
  for (const patch of [{ screenOn: true }, { remoteEnabled: false }, { connected: false }, { locked: true }]) {
    const w = watch(t); await w.reply({ ok: true, state: { ...dark, ...patch } });
    assert.equal(mutations(w).length, 0, JSON.stringify(patch));
    w.page.refresh(); await w.reply({ ok: true, state: { ...dark } });
    assert.equal(mutations(w).length, 0, 'a later change does not replay launch automation');
  }
});

test('a failed opening read does not cause a delayed auto-wake after recovery', async t => {
  const w = watch(t); await w.reject('No phone reply');
  w.page.refresh(); await w.reply({ ok: true, state: { ...dark } });
  assert.equal(mutations(w).length, 0);
});

test('touch, crown, key and local navigation supersede opening-time auto-wake', async t => {
  for (const action of [w => w.touch('down', 240, 230), w => w.crown(1, 0), w => w.key(), w => w.page.navigate('apps')]) {
    const w = watch(t); action(w); await w.reply({ ok: true, state: { ...dark } });
    assert.equal(wakes(w).length, 0);
  }
});

test('watch sleep before the opening reply cancels auto-wake across resume', async t => {
  const w = watch(t); w.screen(2); w.screen(1);
  await w.reply({ ok: true, state: { ...dark } });
  assert.equal(mutations(w).length, 0); assert.equal(w.requests.at(-1).operation.kind, 'state');
  await w.reply({ ok: true, state: { ...dark } }); assert.equal(mutations(w).length, 0);
});

test('watch-screen resume after launch refreshes without automatically waking dark glasses', async t => {
  const w = watch(t); await w.reply({ ok: true, state: { ...sampleState } });
  w.screen(2); w.screen(1); await w.reply({ ok: true, state: { ...dark } });
  assert.equal(mutations(w).length, 0);
});

test('leaving before the opening reply prevents wake and follow-up work', async t => {
  const w = watch(t); w.key(8); await w.reply({ ok: true, state: { ...dark } });
  assert.equal(mutations(w).length, 0); assert.equal(w.requests.length, 1);
});

test('a rejected or uncertain automatic wake is never retried', async t => {
  for (const unknown of [false, true]) {
    const w = watch(t); await w.reply({ ok: true, state: { ...dark } });
    if (unknown) await w.reject('timeout'); else await w.reply({ ok: false, error: 'Glasses are locked' });
    assert.equal(w.requests.at(-1).operation.kind, 'state');
    await w.reply({ ok: true, state: { ...dark } });
    w.advance(3000); await w.reply({ ok: true, state: { ...dark } });
    assert.equal(wakes(w).length, 1);
  }
});

async function manual(t, patch = {}) {
  const w = watch(t); w.crown(1, 0); // Manual interaction cancels opening-time wake.
  await w.reply({ ok: true, state: { ...dark, ...patch } }); return w;
}

test('one crown press explicitly wakes an off display; an on display keeps select and scroll', async t => {
  for (const key of [1, 2]) {
    const w = await manual(t); assert.equal(w.page.padTitle.props.text, 'Press crown'); w.key(key);
    assert.equal(wakes(w).length, 1); assert.equal(mutations(w).length, 1);
    await w.reply({ ok: true }); await w.reply({ ok: true, state: { ...sampleState } });
    w.crown(24, 500); assert.equal(w.requests.at(-1).operation.gesture, 'scroll-up');
    await w.reply({ ok: true });
    w.key(key); assert.equal(w.requests.at(-1).operation.gesture, 'click');
    assert.equal(wakes(w).length, 1);
  }
});

test('crown press cannot wake locked, disconnected or disabled glasses', async t => {
  for (const patch of [{ locked: true }, { connected: false }, { remoteEnabled: false }]) {
    const w = await manual(t, patch); w.key(); assert.equal(mutations(w).length, 0);
    assert.equal(w.page.commandFeedback.snapshot().phase, 'blocked');
  }
});

test('a stale dark-display crown press refreshes without replay', async t => {
  const w = await manual(t); w.advance(15001);
  w.key(); assert.equal(mutations(w).length, 0);
  assert.equal(w.page.commandFeedback.snapshot().phase, 'skipped');
  await w.reply({ ok: true, state: { ...dark } }); assert.equal(mutations(w).length, 0);
  w.key(); assert.equal(wakes(w).length, 1);
});

test('one fresh crown press waits briefly for an ongoing status read, then wakes once', async t => {
  const w = await manual(t); w.page.refresh(); w.key();
  assert.equal(w.page.commandFeedback.snapshot().phase, 'queued'); assert.equal(wakes(w).length, 0);
  w.advance(200); await w.reply({ ok: true, state: { ...dark } });
  assert.equal(wakes(w).length, 1);
  await w.reply({ ok: true }); await w.reply({ ok: true, state: { ...sampleState } });
  assert.equal(wakes(w).length, 1);
});

test('changed display/target, lock, disconnection or disabled control cancels a waiting crown wake', async t => {
  for (const patch of [{ screenOn: true }, { locked: true }, { connected: false }, { remoteEnabled: false },
    { windows: dark.windows.map(window => ({ ...window, focused: window.windowId === 'notes:2' })) }]) {
    const w = await manual(t); w.page.refresh(); w.key();
    await w.reply({ ok: true, state: { ...dark, ...patch } }); assert.equal(wakes(w).length, 0);
  }
});

test('a waiting crown wake expires and cannot send after sleep, exit or a late read', async t => {
  for (const cancel of [w => w.advance(1001), w => w.screen(2), w => w.key(8)]) {
    const w = await manual(t); w.page.refresh(); w.key(); cancel(w);
    await w.reply({ ok: true, state: { ...dark } }); assert.equal(wakes(w).length, 0);
  }
});

test('repeated crown presses cannot duplicate or queue an in-flight wake', async t => {
  const w = await manual(t); w.key(); w.key(); w.key();
  assert.equal(wakes(w).length, 1);
  await w.reply({ ok: true }); await w.reply({ ok: true, state: { ...sampleState } });
  assert.equal(wakes(w).length, 1);
});
