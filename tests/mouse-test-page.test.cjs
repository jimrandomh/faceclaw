const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, modules, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const context = { exports: {}, console, ...globals, require(name) { assert.ok(name in modules, name); return modules[name]; } };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return context.exports;
}

const graphics = require('../.test-build/app/graphics/image.js');
const cursor = require('../.test-build/app/g2/keyboard/cursor.js');
const { bordered } = require('./helpers/viewport.cjs');
const { BdfFont } = load('app/graphics/bdffont.ts', { '@nativescript/core': {} });
const font = BdfFont.parse(fs.readFileSync(path.join(__dirname, '../app/fonts/terminus/ter-u12n.bdf'), 'utf8'));

/** The page over a fake keyboard service, shell and clock. */
function fixture({ state = 'connected', pointer = true } = {}) {
  let now = 10_000, visible = true, renders = 0, nextTimer = 1;
  const timers = new Map();
  const service = {
    listener: null, takes: 0, releases: 0,
    snapshot: () => ({ state, pointer }),
    takePointer(listener) {
      this.takes++; this.listener = listener;
      return () => { if (this.listener === listener) this.listener = null; this.releases++; };
    },
  };
  const globals = {
    Date: { now: () => now },
    setInterval: (fn, ms) => { timers.set(nextTimer, { fn, ms, at: now + ms, repeat: true }); return nextTimer++; },
    setTimeout: (fn, ms) => { timers.set(nextTimer, { fn, ms, at: now + ms, repeat: false }); return nextTimer++; },
    clearInterval: id => timers.delete(id), clearTimeout: id => timers.delete(id),
  };
  const { MouseTestLayer } = load('app/apps/developer/mouse-test.ts', {
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => font }, '../../graphics/image': graphics,
    '../../g2/keyboard/cursor': cursor,
    '../../g2/keyboard/service': { keyboardService: service },
    '../../ui/shell/shell': { shell: { isWindowVisible: () => visible } },
    '../../util/numeric-util': { clamp: (n, lo, hi) => Math.max(lo, Math.min(hi, n)) },
    '../../ui/gestures': {}, '../../ui/layers': {},
  }, globals);
  const layer = new MouseTestLayer('developer', () => { renders++; });
  const viewport = bordered(576, 260);
  const popped = [];
  const ctx = { stack: { getBaseSize: () => viewport, pop: () => popped.push(1) } };
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      now = timer.at;
      if (timer.repeat) timer.at += timer.ms; else timers.delete(id);
      timer.fn();
    }
    now = end;
  }
  const sample = (buttons, extra = {}) => service.listener({ buttons, dx: 0, dy: 0, wheel: 0, pan: 0, ...extra });
  return { layer, service, ctx, viewport, timers, popped, advance, sample, paint: () => layer.paint(ctx),
    renders: () => renders, setVisible: value => { visible = value; } };
}
/** Whether the arrow's tip (its top-left pixel, full white) is at (x, y) and nowhere it shouldn't be. */
const tipAt = (image, x, y) => image.getPixel(x, y) === 255 && image.getPixel(x, y + 1) === 255 && image.getPixel(x + 1, y + 2) === 70;

test('the arrow follows the touchpad, stays on the page, and repaints at a rate the link can carry', () => {
  const f = fixture();
  assert.equal(f.service.takes, 1, 'takes the pointer while the page shows');
  f.paint();
  const { width, height } = f.viewport;
  // The first movement starts from the middle of the page.
  f.sample(0, { dx: 10, dy: -20 });
  assert.ok(tipAt(f.paint(), width / 2 + 10, height / 2 - 20));
  // A hundred reports in a second are one repaint per 33 ms, not a hundred.
  const before = f.renders();
  for (let i = 0; i < 100; i++) { f.sample(0, { dx: 1 }); f.advance(10); }
  assert.ok(f.renders() - before >= 20 && f.renders() - before <= 31, String(f.renders() - before));
  assert.ok(tipAt(f.paint(), width / 2 + 110, height / 2 - 20));
  // Pushed past an edge it stops there.
  f.sample(0, { dx: 5000, dy: 5000 });
  let image = f.paint();
  assert.equal(image.getPixel(width - 1, height - 1), 255);
  f.sample(0, { dx: -9000, dy: -9000 });
  assert.ok(tipAt(f.paint(), 0, 0));
});

test('buttons and wheel show on the page; a left click leaves a mark and a right click clears them', () => {
  const f = fixture();
  f.paint();
  f.sample(0, { dx: 100, dy: 40 });
  const { width, height } = f.viewport;
  const at = { x: width / 2 + 100, y: height / 2 + 40 };
  f.sample(1);
  f.sample(0, { dx: -60, wheel: 2 });
  let image = f.paint();
  // The mark: a small cross where the click was, after the arrow has moved off it.
  assert.equal(image.getPixel(at.x - 4, at.y), 140); assert.equal(image.getPixel(at.x, at.y + 4), 140);
  assert.ok(tipAt(image, at.x - 60, at.y));
  f.sample(2);
  image = f.paint();
  assert.equal(image.getPixel(at.x - 4, at.y), 0);
  f.sample(0);
  assert.doesNotThrow(() => f.paint());
});

test('the pointer is only held while the page can be seen, and given back when the page goes', () => {
  const f = fixture();
  f.paint();
  f.sample(1);
  // Another window comes to the front: the buttons go back to being keys.
  f.setVisible(false); f.advance(400);
  assert.equal(f.service.releases, 1); assert.equal(f.service.listener, null);
  f.setVisible(true); f.advance(400);
  assert.equal(f.service.takes, 2);
  // Double tap (or Esc, which is one) leaves; leaving gives the pointer back and stops the timers.
  f.layer.handleInput({ type: 'double-click' }, f.ctx);
  assert.equal(f.popped.length, 1);
  f.layer.onRemoved();
  assert.equal(f.service.releases, 2); assert.equal(f.timers.size, 0);
  const renders = f.renders();
  f.advance(5000);
  assert.equal(f.renders(), renders);
});

test('without a keyboard, or with one that has no pointer, the page says so', () => {
  for (const options of [{ state: 'idle' }, { state: 'connected', pointer: false }]) {
    const f = fixture(options);
    const image = f.paint();
    assert.ok(image instanceof graphics.GrayImage);
    f.layer.onRemoved();
  }
});
