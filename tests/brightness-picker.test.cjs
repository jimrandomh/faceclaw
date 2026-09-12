const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, modules = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const context = { exports: {}, require: (name) => modules[name] ?? {}, console };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context, { filename: file });
  return context.exports;
}

const textwrap = load('app/graphics/textwrap.ts');
const graphics = load('app/graphics/image.ts', { './textwrap': textwrap });
const plane = load('app/graphics/plane.ts', { './image': graphics });
const gestures = load('app/ui/gestures.ts');
const numeric = load('app/util/numeric-util.ts');
const { BdfFont } = load('app/graphics/bdffont.ts');
const font = BdfFont.parse(fs.readFileSync(path.join(__dirname, '../app/fonts/terminus/ter-u18n.bdf'), 'utf8'));
const fonts = { getDefaultSmallFont: () => font };
const layers = load('app/ui/layers.ts', {
  '../graphics/image': graphics, '../graphics/plane': plane, './gestures': gestures,
  '../native/frame-timings': { spanCurrent: (_name, paint) => paint() },
});
const menu = load('app/ui/menu.ts', {
  '../graphics/image': graphics, '../graphics/ui-fonts': fonts, '../graphics/textwrap': textwrap,
  '../util/numeric-util': numeric, './gestures': gestures, './metrics': load('app/ui/metrics.ts'),
});

function fixture(initial = '50', viewport = { x: 64, y: 124, width: 576, height: 260 }) {
  let value = initial, writes = 0, closed = 0;
  const settings = {
    brightnessSetting: { get: () => value, set: (next) => { value = next; writes++; } },
    brightnessSettingToLevel: (value) => value === 'auto' ? null : Number(value),
  };
  const geometry = {
    appViewportRect: () => viewport, SHELL_OPAQUE_BLACK: 1,
    sidebarWidth: () => viewport.x, minWindowTop: () => viewport.y - 28, TOP_BAR_HEIGHT: 28,
  };
  const picker = load('app/ui/shell/brightness-picker-layer.ts', {
    '../../graphics/ui-fonts': fonts, '../../util/numeric-util': numeric,
    '../dashboard-settings': settings, '../gestures': gestures, './geometry': geometry,
  });
  const base = { paint: () => new graphics.GrayImage(640, 480), handleInput() {} };
  const stack = new layers.LayerStack(base, layers.noopLayerActions);
  const open = () => stack.push(new picker.BrightnessPickerLayer(() => closed++));
  open();
  return { stack, open, settings, geometry, picker, value: () => value, writes: () => writes,
    closed: () => closed, input: (type) => stack.handleInput(gestures.makeInputEvent({ type, source: 'watch' })) };
}

test('swipes change the saved level by 10, clamp at both ends, and both tap gestures confirm', async () => {
  const f = fixture();
  await f.input('swipe-up'); assert.equal(f.value(), '60');
  await f.input('swipe-down'); assert.equal(f.value(), '50');
  for (let i = 0; i < 8; i++) await f.input('scroll-up');
  assert.equal(f.value(), '100'); assert.equal(f.writes(), 7);
  await f.input('click'); assert.ok(f.stack.isAtBase()); assert.equal(f.closed(), 1);
  f.open();
  for (let i = 0; i < 12; i++) await f.input('scroll-down');
  assert.equal(f.value(), '0'); assert.equal(f.writes(), 17);
  await f.input('double-click'); assert.ok(f.stack.isAtBase()); assert.equal(f.closed(), 2);
  assert.equal(f.value(), '0');
});

test('enabling Auto while the picker is open prevents manual changes', async () => {
  const f = fixture();
  f.settings.brightnessSetting.set('auto');
  await f.input('scroll-up'); await f.input('scroll-down');
  assert.equal(f.value(), 'auto'); assert.equal(f.writes(), 1);
});

test('the thin bar fills upward in proportion to brightness in each viewport', () => {
  for (const viewport of [
    { x: 64, y: 28, width: 576, height: 260 },
    { x: 64, y: 220, width: 576, height: 260 },
    { x: 0, y: 28, width: 640, height: 452 },
  ]) {
    for (const level of [0, 10, 50, 100]) {
      const f = fixture(String(level), viewport);
      const image = f.stack.paint().at(-1).image;
      const fill = [];
      for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
          if (image.getPixel(x, y) === 255) fill.push({ x, y });
        }
      }
      assert.equal(fill.length, 12 * level);
      if (level) {
        assert.equal(new Set(fill.map((p) => p.x)).size, 12);
        assert.equal(new Set(fill.map((p) => p.y)).size, level);
        assert.ok(fill.every((p) => p.x >= viewport.x && p.x < viewport.x + viewport.width
          && p.y >= viewport.y && p.y < viewport.y + viewport.height));
        const bottom = fill.at(-1);
        assert.equal(image.getPixel(bottom.x, bottom.y + 1), 1);
        assert.equal(image.getPixel(bottom.x, bottom.y + 2), 150);
      }
    }
  }
});

test('system menu hides brightness in Auto and opens its picker between Voice input and Debug', async () => {
  const f = fixture('auto');
  const { shell } = load('app/ui/shell/shell.ts', {
    '../../graphics/image': graphics, '../layers': layers, '../menu': menu, '../gestures': gestures,
    '../dashboard-settings': f.settings, './geometry': f.geometry, './brightness-picker-layer': f.picker,
    './chrome-layer': { ShellChromeLayer: class {} },
  });
  shell.registerWindow({ windowId: 'test', appId: 'test', closeable: true, handleInput() {} });
  shell.openSystemMenu('test');
  let opened = shell.stack.layers.at(-1);
  assert.deepEqual(Array.from(opened.items, (item) => item.label),
    ['Close window', 'Focus app switcher', 'Voice input', 'Debug']);
  shell.stack.clearToBase();
  f.settings.brightnessSetting.set('40');
  shell.openSystemMenu('test');
  opened = shell.stack.layers.at(-1);
  assert.deepEqual(Array.from(opened.items, (item) => item.label),
    ['Close window', 'Focus app switcher', 'Voice input', 'Brightness', 'Debug']);
  await shell.stack.handleInput(gestures.makeInputEvent({ type: 'scroll-down' }));
  await shell.stack.handleInput(gestures.makeInputEvent({ type: 'scroll-down' }));
  await shell.stack.handleInput(gestures.makeInputEvent({ type: 'click', source: 'ring' }));
  assert.ok(shell.stack.topMatches((layer) => layer instanceof f.picker.BrightnessPickerLayer));
  await shell.stack.handleInput(gestures.makeInputEvent({ type: 'double-click', source: 'ring' }));
  assert.ok(shell.stack.isAtBase());
  assert.equal(shell.focus, 'sidebar');
});
