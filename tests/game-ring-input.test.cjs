const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.join(__dirname, '..');
function load(file, modules = {}, globals = {}, extra = '') {
  const context = { exports: {}, console, ...globals, require(name) {
    assert.ok(name in modules, `Unexpected dependency ${name}`); return modules[name];
  } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText + extra, context);
  return context.exports;
}
const gestures = load('app/ui/gestures.ts');
const textwrap = load('app/graphics/textwrap.ts');
const graphics = load('app/graphics/image.ts', { './textwrap': textwrap });
const { BdfFont } = load('app/graphics/bdffont.ts', { '@nativescript/core': {} });
const font = size => BdfFont.parse(fs.readFileSync(path.join(root, `app/fonts/terminus/ter-u${size}n.bdf`), 'utf8'));
const fonts = { terminus24: font(24), terminus32: font(32) }, small = font(18);
function worker(game) {
  let now = 10000, id = 0, renders = 0;
  const timers = new Map(), posts = [];
  const schedule = (fn, delay, repeat) => { timers.set(++id, { fn, at: now + delay, repeat }); return id; };
  const cancel = id => timers.delete(id);
  const global = { postMessage: m => posts.push(m) };
  class Menu {
    constructor(options) { this.options = options; this.opened = false; }
    isOpen() { return this.opened; }
    open() { this.opened = true; }
    async handleInput(e) {
      if (e.type === 'click') this.options.items()[0].onSelect({ stack: { pop: () => { this.opened = false; } } });
      if (e.type === 'double-click' || e.type === 'system-menu-opened') this.opened = false;
    }
  }
  const modules = {
    '@nativescript/core/globals': {}, '../../graphics/image': graphics,
    '../../graphics/plane': {}, '../../graphics/glyph-wire': {},
    '../../graphics/bdffont': { getFont: name => fonts[name] },
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => small },
    '../../native/frame-timings': { finishFrame() {}, logFrame() {} },
    '../../native/active-display': {}, '../../native/worker-buzzer': {},
    '../../native/settings-store': { getStringSetting: () => '0', setStringSetting() {} },
    '../../ui/sound-effects': {}, '../../ui/sound-setting': { loadSoundEnabled: () => false, saveSoundEnabled() {} },
    '../../ui/window-menu': { WindowMenu: Menu }, '../../ui/gestures': gestures,
    '../../util/numeric-util': { clamp: (v, a, b) => Math.max(a, Math.min(b, v)) },
    './flappy-sprites': load('app/apps/flappy/flappy-sprites.ts', { '../../graphics/image': graphics }),
  };
  const extra = game === 'blocks' ? 'tick, hardDrop, idleDelayMs, dropIntervalMs, spawnPiece, windowMenu' :
    game === 'pinball' ? 'stepFlippers, flip, launchBall, windowMenu' : 'flap, windowMenu';
  const api = load(`app/apps/${game}/${game}-app.worker.ts`, modules, {
    global, Date: { now: () => now },
    setTimeout: (f, d) => schedule(f, d, 0), clearTimeout: cancel,
    setInterval: (f, d) => schedule(f, d, d), clearInterval: cancel,
    recordRender: () => renders++,
  }, `\nrenderAndSubmit = () => recordRender(); playSfx = () => {};
exports.api = { windows, resetGame, paintContent, ${extra} };`).api;
  const message = data => global.onmessage({ data });
  message({ type: 'open-window', windowId: 'test', surfaceId: 'test', title: game, viewport: { width: 576, height: 288 } });
  message({ type: 'foreground', windowId: 'test', foreground: true, focused: true });
  const w = api.windows.get('test');
  if (game === 'blocks') { w.pieceIndex = 2; w.pieceRotation = 0; w.pieceY = 0; w.pieceX = 3; }
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      const [key, t] = next; now = t.at;
      if (t.repeat) t.at += t.repeat; else timers.delete(key);
      t.fn();
    }
    now = end;
  }
  return { ...api, w, message, advance, posts, timers, now: () => now, renders: () => renders,
    elapse: ms => { now += ms; }, input: (type, source = 'ring') => message({
      type: 'input', windowId: 'test', focused: true, frameId: 1, event: { type, source, timestampMs: now },
    }) };
}

for (const [sequence, rotations, x] of [
  [['ring-press','click'],1,3], [['ring-press',300],1,3],
  [['ring-press',300,'click'],1,3], [['ring-press','ring-press','double-click'],2,3],
  [['ring-press','ring-press','ring-press','double-click'],3,3],
  [['ring-press','scroll-up'],0,2], [['ring-press','scroll-down'],0,4],
  [['ring-press','ring-press','ring-press','scroll-up'],2,2],
  [['ring-press','scroll-up','click'],0,2], [['click','double-click'],0,3],
]) test(`Blocks: ${sequence.join(', ')} gives ${rotations} rotations`, () => {
  const h = worker('blocks');
  for (const step of sequence) typeof step === 'number' ? h.advance(step) : h.input(step);
  h.advance(350);
  assert.equal(h.w.pieceRotation, rotations); assert.equal(h.w.pieceX, x);
  assert.equal(h.w.phase, 'playing'); assert.equal(h.w.pendingRotationTimer, null);
});

test('Blocks replaces only the last buffered press and expires at 300 ms', () => {
  const h = worker('blocks'); h.input('ring-press'); h.advance(200); h.input('ring-press');
  assert.equal(h.w.pieceRotation, 1); h.advance(299); assert.equal(h.w.pieceRotation, 1);
  h.advance(1); assert.equal(h.w.pieceRotation, 2); h.input('double-click'); assert.equal(h.w.pieceRotation, 2);
});

test('Blocks a click from another source commits the pending rotation without duplicating it', () => {
  const h = worker('blocks'); h.input('ring-press'); h.input('click', 'left-arm');
  h.advance(300); assert.equal(h.w.pieceRotation, 1);
  h.input('click', 'watch'); assert.equal(h.w.pieceRotation, 2);
});

test('Blocks idle acceleration starts at the deadline, runs at 5x, and ends on input', () => {
  const h = worker('blocks'); h.advance(1000);
  assert.equal(h.w.pieceY, 0);
  const before = h.w.gravityProgress; h.advance(300);
  assert.ok(Math.abs((h.w.pieceY + h.w.gravityProgress) - before - 1) < 1e-9);
  h.input('scroll-down'); const afterInput = h.w.pieceY + h.w.gravityProgress;
  h.advance(300);
  assert.ok(Math.abs((h.w.pieceY + h.w.gravityProgress) - afterInput - 0.2) < 1e-9);
  for (const [lines, expected] of [[0,1000],[10,950],[50,750],[100,500],[200,500]]) {
    h.w.lines = lines; assert.equal(h.idleDelayMs(h.w), expected);
  }
});

test('Blocks continuous input cannot reset gravity progress; timeout rotation is not fresh input', () => {
  const h = worker('blocks');
  for (let i = 0; i < 20; i++) { h.input(i % 2 ? 'scroll-up' : 'scroll-down'); h.advance(100); }
  assert.equal(h.w.pieceY, 1);
  h.input('ring-press'); const when = h.w.lastInputAtMs; h.advance(300);
  assert.equal(h.w.lastInputAtMs, when);
});

test('Blocks landing resets acceleration and prevents a pending rotation from reaching the next piece', () => {
  const h = worker('blocks'); h.advance(1100); h.input('ring-press');
  h.hardDrop(h.w);
  assert.equal(h.w.gravityProgress, 0); assert.equal(h.w.lastInputAtMs, h.now());
  h.advance(300); assert.equal(h.w.pieceRotation, 0);
  assert.equal(h.w.gravityProgress.toFixed(3), '0.200');
  // Let a naturally falling piece land while accelerated, then inspect its successor.
  h.w.pieceY = 17; h.w.board.fill(0);
  while (h.w.pieceY >= 17) h.advance(20);
  assert.equal(h.w.gravityProgress, 0); assert.equal(h.w.lastInputAtMs, h.now());
});

test('Blocks hold pauses without dropping, opens a menu, and resumes with a fresh idle delay', async () => {
  const h = worker('blocks'); h.input('ring-press'); h.advance(100); h.input('long-press');
  assert.equal(h.w.phase, 'paused'); assert.equal(h.w.pieceY, 0);
  assert.ok(h.w.menu.isOpen()); assert.equal(h.w.menu.options.claimsLongPress(), false);
  h.advance(5000); assert.equal(h.w.pieceRotation, 0); assert.equal(h.w.pieceY, 0);
  h.input('click'); await Promise.resolve();
  assert.equal(h.w.phase, 'playing'); assert.equal(h.w.lastInputAtMs, h.now());
  assert.equal(h.w.menu.options.claimsLongPress(), true);
  h.advance(500); assert.equal(h.w.pieceY, 0);
});

for (const event of [
  { type: 'input-focus', windowId: 'test', focused: false },
  { type: 'foreground', windowId: 'test', foreground: false, focused: false },
  { type: 'screen', on: false }, { type: 'close-window', windowId: 'test' },
]) test(`Blocks cancels buffered input and timers on ${event.type}`, () => {
  const h = worker('blocks'); h.input('ring-press'); h.message(event); h.advance(2000);
  assert.equal(h.w.pieceRotation, 0); assert.equal(h.timers.size, 0);
});

test('Flappy acts on down and ignores subsequent ring click/scroll; watch still flaps', () => {
  const h = worker('flappy'); h.input('ring-press');
  assert.equal(h.w.phase, 'playing'); assert.ok(h.w.birdVy < 0);
  h.w.birdVy = 20; h.input('click'); h.input('scroll-up'); assert.equal(h.w.birdVy, 20);
  h.input('swipe-up', 'watch'); assert.ok(h.w.birdVy < 0);
  h.w.birdVy = 20; h.input('click', 'watch'); assert.ok(h.w.birdVy < 0);
});

test('Pinball pulses both flippers for 300 ms, extends on another press, and ignores click in play', () => {
  const h = worker('pinball'); h.w.ballState = 'live'; h.input('ring-press');
  assert.ok(h.w.flippers.every(f => f.state === 'rising' && f.holdUntilMs === h.now() + 300));
  h.stepFlippers(h.w, 0.2); assert.ok(h.w.flippers.every(f => f.state === 'hold'));
  h.elapse(200); h.input('click'); assert.ok(h.w.flippers.every(f => f.holdUntilMs === h.now() + 100));
  h.input('ring-press'); h.elapse(299); h.stepFlippers(h.w, 0);
  assert.ok(h.w.flippers.every(f => f.state === 'hold'));
  h.elapse(1); h.stepFlippers(h.w, 0); assert.ok(h.w.flippers.every(f => f.state === 'falling'));
});

test('Pinball swipes no longer flip; plunger power and click launch remain', () => {
  const h = worker('pinball'); h.w.ballState = 'live';
  for (const type of ['scroll-up','scroll-down','swipe-left','swipe-right']) h.input(type);
  assert.ok(h.w.flippers.every(f => f.state === 'rest'));
  h.w.ballState = 'ready'; h.w.launchPower = 2;
  h.input('scroll-up'); assert.equal(h.w.launchPower, 3);
  h.input('scroll-down'); assert.equal(h.w.launchPower, 2);
  h.input('click'); assert.equal(h.w.ballState, 'live');
});
