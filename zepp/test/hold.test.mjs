import test from 'node:test';
import assert from 'node:assert/strict';
import { watchFixture } from './fixture.mjs';

async function ready(t) {
  const w = watchFixture(); t.after(() => w.page.onDestroy());
  await w.reply(); return w;
}
const gestures = w => w.requests.filter(request => request.operation.kind === 'gesture');
const feedback = w => w.page.commandFeedback.snapshot();

test('hold sends at 600ms while the finger stays down, with immediate progress', async t => {
  const w = await ready(t); w.touch('down', 240, 230);
  w.advance(599); assert.equal(gestures(w).length, 0);
  w.advance(1);
  assert.equal(w.page.touching, true);
  assert.equal(gestures(w).length, 1); assert.equal(gestures(w)[0].operation.gesture, 'long-press');
  assert.match(feedback(w).text, /^Long press\nSending/);
  await w.reply({ ok: true }); await w.reply();
  w.advance(3000); assert.equal(gestures(w).length, 1);
  w.touch('move', 350, 230); w.touch('up', 350, 230, 50); w.advance(300);
  assert.equal(w.page.touching, false); assert.equal(gestures(w).length, 1);
});

test('tap then hold sends the app gesture at the second hold threshold, before release', async t => {
  const w = await ready(t);
  w.touch('down', 240, 230); w.touch('up', 240, 230, 50);
  w.advance(200); w.touch('down', 240, 230);
  w.advance(599); assert.equal(gestures(w).length, 0);
  w.advance(1);
  assert.equal(w.page.touching, true); assert.equal(gestures(w).length, 1);
  assert.equal(gestures(w)[0].operation.gesture, 'short-then-long-press');
  assert.match(feedback(w).text, /^Tap then hold\nSending/);
  w.touch('up', 240, 230, 100); w.advance(500);
  assert.equal(gestures(w).length, 1);
});

test('two short taps still send only a double tap, never a late hold', async t => {
  const w = await ready(t);
  w.touch('down', 240, 230); w.touch('up', 240, 230, 40);
  w.advance(150); w.touch('down', 240, 230); w.touch('up', 240, 230, 40);
  w.advance(1000);
  assert.equal(gestures(w).length, 1); assert.equal(gestures(w)[0].operation.gesture, 'double-click');
});

test('dragging before the hold threshold remains a single swipe on release', async t => {
  const w = await ready(t); w.touch('down', 240, 230);
  w.advance(300); w.touch('move', 140, 230); w.advance(400);
  assert.equal(gestures(w).length, 0);
  w.touch('up', 140, 230);
  assert.equal(gestures(w).length, 1); assert.equal(gestures(w)[0].operation.gesture, 'swipe-left');
  w.advance(1000); assert.equal(gestures(w).length, 1);
});

test('leaving the pad, navigating, sleeping, and quitting cancel an unrecognized hold', async t => {
  for (const cancel of [
    w => w.touch('cancel', 240, 230), w => w.page.navigate('apps'), w => w.screen(2), w => w.key(8),
  ]) {
    const w = await ready(t); w.touch('down', 240, 230); w.advance(599);
    cancel(w); w.advance(1000);
    assert.equal(gestures(w).length, 0);
  }
});

test('using the crown cancels a pending hold without leaving a delayed tap', async t => {
  const w = await ready(t); w.touch('down', 240, 230); w.advance(300);
  w.crown(-24, 0); w.advance(400); w.touch('up', 240, 230); w.advance(300);
  assert.deepEqual(gestures(w).map(request => request.operation.gesture), ['scroll-down']);
});

test('a hold blocked by a sent action is not retried when the finger is released', async t => {
  const w = await ready(t); w.page.gesture('click');
  w.touch('down', 240, 230); w.advance(600);
  assert.match(feedback(w).text, /^Long press\nBusy · Not sent$/);
  await w.reply({ ok: true }); await w.reply();
  w.touch('up', 240, 230); w.advance(1000);
  assert.deepEqual(gestures(w).map(request => request.operation.gesture), ['click']);
});

test('a recognized hold may wait behind a read and sends once before the finger is released', async t => {
  const w = await ready(t); w.page.refresh(); w.touch('down', 240, 230); w.advance(600);
  assert.equal(feedback(w).phase, 'queued'); assert.equal(gestures(w).length, 0);
  await w.reply();
  assert.equal(w.page.touching, true); assert.equal(gestures(w).length, 1);
  assert.equal(gestures(w)[0].operation.gesture, 'long-press');
  w.touch('up', 240, 230); w.advance(500);
  assert.equal(gestures(w).length, 1);
});

test('leaving the pad cancels a hold that has been recognized but not sent', async t => {
  const w = await ready(t); w.page.refresh(); w.touch('down', 240, 230); w.advance(600);
  assert.equal(feedback(w).phase, 'queued');
  w.touch('cancel', 240, 230); await w.reply();
  assert.equal(gestures(w).length, 0); assert.equal(feedback(w).pending, false);
});
