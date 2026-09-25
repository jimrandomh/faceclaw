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
const { BdfFont } = load('app/graphics/bdffont.ts', { '@nativescript/core': {} });
const font = BdfFont.parse(fs.readFileSync(path.join(__dirname, '../app/fonts/terminus/ter-u12n.bdf'), 'utf8'));
const textwrap = load('app/graphics/textwrap.ts', {});
const fonts = { getDefaultSmallFont: () => font };
const menu = load('app/ui/menu.ts', {
  '../graphics/image': graphics, '../graphics/textwrap': textwrap, '../graphics/ui-fonts': fonts,
  '../util/numeric-util': { clamp: (n, lo, hi) => Math.max(lo, Math.min(hi, n)) }, './gestures': {},
  './metrics': metrics, './menu-core': menuCore,
});
let yields = 0;
const { SettingsPanelLayer } = load('app/ui/dashboard/settings-panel.ts', {
  '../../graphics/ui-fonts': fonts, '../../graphics/image': graphics, '../../graphics/textwrap': textwrap,
  '../gestures': {}, '../layers': {}, '../menu': menu, '../menu-core': menuCore, '../metrics': metrics,
  '../shell/shell': { shell: { yieldFocusToSidebar: () => yields++ } },
});

/** A panel over three sections; records which item callbacks fire. */
function panel() {
  const selected = [];
  const item = (label, extra = {}) => ({ label, onSelect: () => selected.push(label), ...extra });
  const layer = new SettingsPanelLayer([
    { label: 'Display', items: [item('Brightness'), item('Font'), item('Off', { disabled: true })] },
    { label: 'Voice', items: Array.from({ length: 20 }, (_, i) => item(`Voice ${i}`, { description: 'Help text for this option.' })) },
    { label: 'About', items: [], renderDetail: () => {} },
  ]);
  const ctx = { stack: { getBaseSize: () => ({ width: 576, height: 260 }), isFocused: () => true } };
  const input = (type) => layer.handleInput({ type, timestampMs: 0 }, ctx);
  return { layer, input, paint: () => layer.paint(ctx), selected };
}

const selections = (image) => image.draws.filter((d) => d.kind === 'image' && d.presentation);

test('the right column previews the section without a selection until focus enters it', async () => {
  const p = panel();
  assert.equal(selections(p.paint()).length, 1, 'only the left column is highlighted');
  await p.input('click');
  const both = selections(p.paint());
  assert.equal(both.length, 2);
  assert.equal(both[0].presentation.background, 0, 'left column shows an outline once focus moves right');
  assert.ok(both[1].x > 150, 'the right highlight lands in the right column');
  await p.input('click');
  assert.deepEqual(p.selected, ['Brightness']);
  await p.input('double-click');
  assert.equal(selections(p.paint()).length, 1, 'back to a preview');
  const before = yields;
  await p.input('double-click');
  assert.equal(yields, before + 1, 'double-click from the left column yields to the sidebar');
});

test('moving between sections resets the right column to its top, unselected', async () => {
  const p = panel();
  await p.input('scroll-down');
  await p.input('click');
  for (let i = 0; i < 15; i++) await p.input('scroll-down');
  p.paint();
  await p.input('double-click');
  await p.input('scroll-up');
  await p.input('scroll-down');
  assert.equal(selections(p.paint()).length, 1);
  await p.input('click');
  await p.input('click');
  assert.deepEqual(p.selected, ['Voice 0'], 'entering starts at the first item');
});

test('watch swipes move within a column, wrap, and skip disabled activation', async () => {
  const p = panel();
  await p.input('swipe-up');
  await p.input('click');
  assert.deepEqual(p.selected, [], 'About has no items, so focus stays in the left column');
  await p.input('swipe-down');
  await p.input('swipe-right');
  await p.input('swipe-up');
  await p.input('swipe-right');
  assert.deepEqual(p.selected, [], 'the wrapped-to item is disabled');
  await p.input('swipe-up');
  await p.input('swipe-right');
  assert.deepEqual(p.selected, ['Font']);
});

test('the selected row stays clear of its description band', async () => {
  const p = panel();
  await p.input('scroll-down');
  await p.input('click');
  await p.input('scroll-up');
  const row = selections(p.paint())[1];
  const overlay = new graphics.GrayImage(576, 260);
  p.layer.paintDescriptionOverlay(overlay, { stack: { getBaseSize: () => ({ width: 576, height: 260 }) } });
  let bandTop = -1;
  for (let y = 0; y < 260 && bandTop < 0; y++) if (overlay.getPixel(300, y) !== 0) bandTop = y;
  assert.ok(bandTop > 0, 'the band is drawn');
  assert.ok(row.y + row.source.height <= bandTop, `row ends at ${row.y + row.source.height}, band starts at ${bandTop}`);
  assert.ok(row.y + row.source.height > bandTop - 30, 'the last item scrolled down to just above the band');
});
