const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');
function harness() {
  let override = {}, base = { kind: 'ttf', file: 'Roboto-Light.ttf', size: 14 };
  const source = ts.createSourceFile('fonts.ts', fs.readFileSync('app/graphics/ui-fonts.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const functions = source.statements.filter(n => ts.isFunctionDeclaration(n) && ['getBaseUiFontSelection', 'getUiFontSelection', 'setUiFontSelection'].includes(n.name?.text)).map(n => n.getText(source)).join('\n');
  const context = { exports: {}, typographyPolicy: () => override, parseFontSelection: JSON.parse, getStringSetting: key => key === 'font' ? JSON.stringify(base) : '', setStringSetting: (key, value) => { assert.equal(key, 'font'); base = JSON.parse(value); }, UI_FONT_SELECTION_KEY: 'font', LEGACY_UI_FONT_KEY: 'legacy', DEFAULT_UI_FONT: { kind: 'ttf', file: 'Roboto-Light.ttf', size: 14 } };
  vm.runInNewContext(ts.transpileModule(functions, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, context);
  return { api: context.exports, saved: () => base, get: context.exports.getUiFontSelection, override: value => override = value, base: value => base = value };
}
test('font overrides reveal the latest base edit when disabled', () => {
  const h = harness(); h.override({ font: 'Inter_18pt-Regular.ttf', size: 17 });
  assert.equal(h.get().size, 17);
  h.base({ kind: 'ttf', file: 'Montserrat-Light.ttf', size: 19 });
  assert.equal(h.get().file, 'Inter_18pt-Regular.ttf');
  h.override({}); assert.equal(h.get().file, 'Montserrat-Light.ttf'); assert.equal(h.get().size, 19);
});
test('partial typography configuration composes with the current base', () => {
  const h = harness(); h.override({ size: 18 }); assert.equal(h.get().size, 18); assert.equal(h.get().file, 'Roboto-Light.ttf');
  h.override({ font: 'Inter_18pt-Regular.ttf' }); assert.equal(h.get().size, 14);
  h.base({ kind: 'bitmap', face: 'terminus' }); h.override({}); assert.equal(h.get().kind, 'bitmap');
});

function picker(h) {
  const layers = [], menus = [];
  const fonts = ['Roboto-Light.ttf', 'Inter_18pt-Regular.ttf'].map(fileName => ({ fileName, path: fileName, family: fileName, style: 'Regular', weightOrder: 400, monospace: false }));
  const imports = {
    '../graphics/ui-fonts': { ...h.api, uiFontSizeAllowed: () => true, fontSelectionLabel: selection => JSON.stringify(selection) },
    '../graphics/installed-fonts': { listInstalledFonts: () => fonts },
    './extension-settings': { effectiveExtension: () => ({ component: 'app.typography/Service' }) },
    './menu': { openModalMenu: (_ctx, title, items) => { const menu = { title, items }; menus.push(menu); layers.push(menu); } },
    '../graphics/bdffont': {}, '../graphics/image': {}, '../graphics/ttf-font': {}, './gestures': {}, './metrics': {},
  };
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/ui/font-picker.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText,
    { module, exports: module.exports, require: name => { assert.ok(name in imports, name); return imports[name]; } });
  const ctx = { stack: { push: layer => layers.push(layer), pop: () => layers.pop() } };
  const row = module.exports.uiFontPickerMenuItem(); row.onSelect(ctx);
  return { layer: layers[0], ctx, menus, row };
}
test('real UI font picker size-only edit preserves the saved face under an active override', () => {
  const h = harness(); h.override({ font: 'Inter_18pt-Regular.ttf', size: 18 });
  const p = picker(h); assert.match(p.row.description, /Saved:.*Roboto-Light.ttf.*Active:.*Inter_18pt-Regular.ttf.*Owner: app.typography/);
  p.layer.handleInput({ type: 'scroll-down' }, p.ctx); p.layer.handleInput({ type: 'scroll-down' }, p.ctx); p.layer.handleInput({ type: 'click' }, p.ctx);
  assert.equal(p.menus[0].title, 'Size'); p.menus[0].items.find(item => item.label === '16').onSelect(p.ctx);
  p.layer.handleInput({ type: 'scroll-down' }, p.ctx); p.layer.handleInput({ type: 'click' }, p.ctx);
  assert.deepEqual(h.saved(), { kind: 'ttf', file: 'Roboto-Light.ttf', size: 16 });
  assert.equal(h.get().file, 'Inter_18pt-Regular.ttf'); assert.equal(h.get().size, 18);
  h.override({}); assert.equal(h.get().file, 'Roboto-Light.ttf'); assert.equal(h.get().size, 16);
});
test('real UI font picker Save without edits and Cancel never persist active override values', () => {
  for (const cancel of [false, true]) {
    const h = harness(); h.override({ font: 'Inter_18pt-Regular.ttf', size: 18 }); const p = picker(h);
    if (cancel) p.layer.handleInput({ type: 'double-click' }, p.ctx);
    else { for (let i = 0; i < 3; i++) p.layer.handleInput({ type: 'scroll-down' }, p.ctx); p.layer.handleInput({ type: 'click' }, p.ctx); }
    assert.deepEqual(h.saved(), { kind: 'ttf', file: 'Roboto-Light.ttf', size: 14 });
  }
});

test('real picker face-only edit retains baseline size rather than active override size', () => {
  const h = harness(); h.override({ font: 'Inter_18pt-Regular.ttf', size: 18 }); const p = picker(h);
  p.layer.handleInput({ type: 'click' }, p.ctx);
  assert.equal(p.menus[0].title, 'Font Face'); p.menus[0].items.find(item => item.label === 'Inter_18pt-Regular.ttf').onSelect(p.ctx);
  for (let i = 0; i < 3; i++) p.layer.handleInput({ type: 'scroll-down' }, p.ctx); p.layer.handleInput({ type: 'click' }, p.ctx);
  assert.deepEqual(h.saved(), { kind: 'ttf', file: 'Inter_18pt-Regular.ttf', size: 14 });
  h.override({}); assert.equal(h.get().size, 14);
});
