const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app/apps/evenhub/session.ts'), 'utf8');
const shim = source.match(/export const EVENHUB_BRIDGE_INJECT_SCRIPT = `([\s\S]*?)`;/)[1];

function page() {
  const state = { now: 1000, wakes: 0, log: [] };
  const win = {
    Date: { now: () => state.now }, console, Map, Array, Math,
    __faceclawEvenHub: { postMessage() {}, wakeTimers() { state.wakes++; } },
  };
  win.window = win;
  win.performance = { now: () => state.now };
  vm.createContext(win);
  vm.runInContext(shim, win);
  state.win = win;
  state.tick = () => vm.runInContext('__fcTick()', win);
  return state;
}

test('an idle page asks for no ticks, and its first timer wakes the host once', () => {
  const p = page();
  assert.equal(p.tick(), -1);
  p.win.setTimeout(() => p.log.push('a'), 100);
  p.win.setTimeout(() => p.log.push('b'), 200);
  assert.equal(p.wakes, 1);
  p.now += 5;
  assert.equal(p.tick(), 95);
  p.now += 95;
  assert.equal(p.tick(), 100);
  assert.deepEqual(p.log, ['a']);
  p.now += 100;
  assert.equal(p.tick(), -1);
  assert.deepEqual(p.log, ['a', 'b']);
});

test('work due before the scheduled tick wakes the host; work added during a tick does not', () => {
  const p = page();
  p.win.setTimeout(() => {}, 500);
  p.tick();
  const wakes = p.wakes;
  p.win.setTimeout(() => { p.win.setTimeout(() => p.log.push('inner'), 0); }, 10);
  assert.equal(p.wakes, wakes + 1);
  p.now += 10;
  assert.equal(p.tick(), 16, 'the inner zero-delay timer runs next frame');
  assert.equal(p.wakes, wakes + 1);
  p.now += 16;
  p.tick();
  assert.deepEqual(p.log, ['inner']);
});

test('an animation-frame loop keeps the host at frame rate until it stops', () => {
  const p = page();
  let frames = 0;
  const loop = () => { if (++frames < 3) p.win.requestAnimationFrame(loop); };
  p.win.requestAnimationFrame(loop);
  p.now += 16; assert.equal(p.tick(), 16);
  p.now += 16; assert.equal(p.tick(), 16);
  p.now += 16; assert.equal(p.tick(), -1);
  assert.equal(frames, 3);
});

test('intervals keep cadence and the fixed-rate entry points still work', () => {
  const p = page();
  const id = p.win.setInterval(() => p.log.push('iv'), 50);
  p.now += 50; assert.equal(p.tick(), 50);
  p.now += 50; p.tick();
  p.win.clearInterval(id);
  assert.equal(p.tick(), -1);
  p.win.setTimeout(() => p.log.push('legacy'), 0);
  vm.runInContext('__fcTimerTick(); __fcRafTick()', p.win);
  assert.deepEqual(p.log, ['iv', 'iv', 'legacy']);
});
