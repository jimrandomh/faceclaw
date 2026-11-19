const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, modules) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const context = { exports: {}, console, require(name) { assert.ok(name in modules, name); return modules[name]; } };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return context.exports;
}

const graphics = require('../.test-build/app/graphics/image.js');
const metrics = require('../.test-build/app/ui/metrics.js');
const menuCore = require('../.test-build/app/ui/menu-core.js');
const bindings = require('../.test-build/app/g2/keyboard/bindings.js');
const { BdfFont } = load('app/graphics/bdffont.ts', { '@nativescript/core': {} });
const font = BdfFont.parse(fs.readFileSync(path.join(__dirname, '../app/fonts/terminus/ter-u12n.bdf'), 'utf8'));
const textwrap = load('app/graphics/textwrap.ts', {});
const fonts = { getDefaultSmallFont: () => font };
const menu = load('app/ui/menu.ts', {
  './menu-animation-pref': require('../.test-build/app/ui/menu-animation-pref.js'), './animation-speed': require('../.test-build/app/ui/animation-speed.js'), '../native/settings-store': { getStringSetting: (_key, fallback) => fallback }, '../graphics/screen-size': { screenWidth: () => 640, screenHeight: () => 480 },
  '../graphics/image': graphics, '../graphics/textwrap': textwrap, '../graphics/ui-fonts': fonts,
  '../util/numeric-util': { clamp: (n, lo, hi) => Math.max(lo, Math.min(hi, n)) }, './gestures': {},
  './metrics': metrics, './menu-core': menuCore,
});

/** The settings menu over a fake keyboard service and layer stack. */
function fixture({ connected = true, stored = [], room = true } = {}) {
  const service = {
    list: [...stored], capture: null, cancelled: 0,
    bridge: { isConnected: () => connected },
    keyBindings() { return this.list; },
    setKeyBinding(chord, action) {
      if (!room) return false;
      const id = bindings.chordId(chord);
      const index = this.list.findIndex(b => bindings.chordId(b.chord) === id);
      const next = [...this.list];
      if (index < 0) next.push({ chord, action }); else next[index] = { chord, action };
      this.list = next;
      return true;
    },
    removeKeyBinding(chord) { this.list = this.list.filter(b => bindings.chordId(b.chord) !== bindings.chordId(chord)); },
    captureNextKey(onChord) { this.capture = onChord; return () => { if (this.capture === onChord) { this.capture = null; this.cancelled++; } }; },
  };
  class TextViewerLayer { constructor(text, title) { this.text = text; this.title = title; } handleInput(event, ctx) { if (event.type === 'double-click') ctx.stack.pop(); } }
  const { keybindingsMenuItem } = load('app/ui/keybinding-settings.ts', {
    '../graphics/ui-fonts': fonts, '../g2/keyboard/bindings': bindings, '../g2/keyboard/service': { keyboardService: service },
    '../apps/files/text-viewer': { TextViewerLayer }, './menu': menu,
  });
  const layers = [{ base: true }];
  let renders = 0;
  const removed = layer => layer.onRemoved?.();
  const ctx = {
    actions: { requestRender: () => { renders++; } },
    stack: {
      getBaseSize: () => ({ width: 576, height: 260, padding: { top: 0, right: 0, bottom: 0, left: 0 } }), isFocused: () => true,
      push: layer => { layers.push(layer); },
      pop: () => { if (layers.length > 1) removed(layers.pop()); },
      popThrough: layer => {
        const index = layers.indexOf(layer);
        if (index <= 0) return false;
        for (const gone of layers.splice(index).reverse()) removed(gone);
        return true;
      },
    },
  };
  const top = () => layers[layers.length - 1];
  const input = type => top().handleInput({ type, timestampMs: 0 }, ctx);
  const labels = () => top().items.map(item => item.label);
  /** Move the highlight of the menu on top to the row with this label, and select it. */
  async function choose(label) {
    const layer = top();
    for (let i = 0; i <= layer.items.length && layer.selectedItem?.label !== label; i++) await input('scroll-down');
    assert.equal(layer.selectedItem?.label, label, `${label} in ${labels().join(' | ')}`);
    await input('click');
  }
  const item = keybindingsMenuItem();
  return { service, item, ctx, layers, top, input, labels, choose, renders: () => renders,
    open: () => item.onSelect(ctx), chord: (code, mods = {}) => ({ code, shift: false, ctrl: false, alt: false, meta: false, ...mods }) };
}

test('adding a keybinding: the key is read from the keyboard, then an action is picked', async () => {
  const f = fixture();
  f.open();
  assert.deepEqual(f.labels(), ['Add keybinding', 'Default keys']);
  await f.choose('Add keybinding');
  assert.ok(f.service.capture, 'waiting for a key');
  assert.match(f.top().body ?? f.top().constructor.name, /Press the key|KeyCaptureLayer/);
  f.service.capture(f.chord('AudioVolumeUp'));
  // The waiting page is gone and the picker for that key is up, with every action in it.
  assert.equal(f.layers.length, 3); assert.equal(f.top().title, 'Volume Up');
  assert.deepEqual(f.labels(), ['Select', 'Back', 'Swipe up', 'Swipe down', 'Swipe left', 'Swipe right',
    'Scroll up', 'Scroll down', 'System menu', 'App menu', 'Nothing']);
  await f.choose('Scroll up');
  assert.deepEqual(f.service.list, [{ chord: f.chord('AudioVolumeUp'), action: 'scroll-up' }]);
  // Back on the list, on the new row.
  assert.equal(f.layers.length, 2);
  assert.deepEqual(f.labels(), ['Volume Up', 'Add keybinding', 'Default keys']);
  assert.equal(f.top().selectedItem.label, 'Volume Up');
  assert.ok(f.renders() > 0);
});

test('a keybinding can be changed or removed, and a chord is one keybinding however often it is added', async () => {
  const f = fixture();
  f.service.list = [{ chord: f.chord('Escape', { shift: true }), action: 'none' }, { chord: f.chord('KeyQ', { ctrl: true }), action: 'long-press' }];
  f.open();
  assert.deepEqual(f.labels(), ['Shift+Esc', 'Ctrl+Q', 'Add keybinding', 'Default keys']);
  await f.choose('Ctrl+Q');
  // The picker opens on the current action, marks it, and offers removal.
  assert.equal(f.top().selectedItem.label, 'System menu *'); assert.equal(f.labels().at(-1), 'Remove keybinding');
  await f.choose('App menu');
  assert.equal(f.service.list[1].action, 'short-then-long-press'); assert.equal(f.service.list.length, 2);
  // Adding the same chord again edits it rather than making a second one.
  await f.choose('Add keybinding');
  f.service.capture(f.chord('KeyQ', { ctrl: true }));
  assert.equal(f.top().selectedItem.label, 'App menu *');
  await f.choose('Back');
  assert.deepEqual(f.service.list.map(b => b.action), ['none', 'double-click']);
  await f.choose('Shift+Esc');
  await f.choose('Remove keybinding');
  assert.deepEqual(f.labels(), ['Ctrl+Q', 'Add keybinding', 'Default keys']);
});

test('backing out of the wait calls the capture off; with no keyboard there is nothing to wait for', async () => {
  const f = fixture();
  f.open();
  await f.choose('Add keybinding');
  await f.input('double-click');
  assert.equal(f.service.capture, null); assert.equal(f.service.cancelled, 1); assert.equal(f.layers.length, 2);
  // A key pressed after that is not taken for a keybinding.
  assert.deepEqual(f.service.list, []);

  const away = fixture({ connected: false });
  away.open();
  await away.choose('Add keybinding');
  assert.equal(away.service.capture, null);
  assert.match(away.top().body, /No keyboard is connected/);
  await away.input('double-click');
  assert.equal(away.layers.length, 2);
});

test('the defaults are a page of their own, and a full list says so', async () => {
  const f = fixture();
  f.open();
  await f.choose('Default keys');
  assert.equal(f.top().title, 'Default keys');
  for (const phrase of ['Arrow keys', 'Enter', 'Shift+Esc', 'terminal']) assert.ok(f.top().text.includes(phrase), phrase);

  const full = fixture({ room: false });
  full.open();
  await full.choose('Add keybinding');
  full.service.capture(full.chord('F5'));
  await full.choose('Select');
  assert.match(full.top().body, /no room/); assert.deepEqual(full.service.list, []);
});
