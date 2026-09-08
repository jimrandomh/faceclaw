const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function harness() {
  let raw = '', listener;
  const context = { exports: {}, require: () => ({
    getStringSetting: () => raw,
    onSettingsStoreChanged: fn => { listener = fn; return () => { listener = undefined; }; },
  }) };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/ui/extension-settings.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return { ...context.exports, set(features) { raw = JSON.stringify({ version: 1, generation: 1, features }); listener?.('apps.extensions.effective'); }, corrupt() { raw = '{'; } };
}
const entry = (feature, configuration, component = 'example/Service', available = true) => ({ feature, configuration, component, available, live: false, generation: 1 });
test('effective feature values revert independently and emit changes', () => {
  const h = harness(); let changes = 0;
  const off = h.onEffectiveExtensionsChanged(() => changes++);
  h.set([entry('ui.navigation', { rootBack: 'sleep' }), entry('ui.typography', { font: 'Inter_18pt-Regular.ttf', size: 17 })]);
  assert.equal(h.navigationPolicy().rootBack, 'sleep');
  assert.equal(h.typographyPolicy().size, 17);
  h.set([entry('ui.typography', { font: 'Inter_18pt-Regular.ttf', size: 17 })]);
  assert.equal(h.navigationPolicy().rootBack, 'switcher');
  assert.equal(h.typographyPolicy().size, 17);
  assert.equal(changes, 2); off();
});
test('unavailable live providers and malformed snapshots use host defaults', () => {
  const h = harness();
  h.set([entry('ui.navigation', { rootBack: 'sleep' }, 'example/Service', false)]);
  assert.equal(h.navigationPolicy().rootBack, 'switcher');
  h.corrupt(); assert.equal(h.effectiveExtension('ui.navigation'), undefined);
});
test('a provider may hide only its own window header', () => {
  const h = harness(); h.set([entry('ui.window-layout', { ownTopBar: false })]);
  assert.equal(h.showWindowTopBar('apk:example/Service'), false);
  assert.equal(h.showWindowTopBar('apk:other/Service'), true);
  assert.equal(h.showWindowTopBar('calculator'), true);
  h.set([]); assert.equal(h.showWindowTopBar('apk:example/Service'), true);
});
