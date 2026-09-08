const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function harness() {
 const module = { exports: {} }, menus = [], opened = [], priorities = [], timers = [], layers = [];
 const behavior = { feature: 'transcription', component: 'app.t3/Service', live: true, available: true,
  contenders: [{ component: 'app.t3/Service', enabled: true, granted: true, connected: true }, { component: 'app.other/Service', enabled: true, granted: false, connected: true }] };
 const imports = {
  '../../apps/external/platform': { installedAndroidApps: () => [{ name: 'T3', packageName: 'app.t3' }, { name: 'Other', packageName: 'app.other' }], openAndroidAppSettings: pkg => { opened.push(pkg); return true; }, prioritizeExtension: (feature, component) => { priorities.push([feature, component]); return true; } },
  '../extension-settings': { extensionBehaviors: () => [behavior] }, '../menu': { openModalMenu: (_ctx, title, items) => menus.push({ title, items }) },
 };
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/ui/dashboard/app-settings-menus.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText,
  { module, exports: module.exports, require: name => imports[name] || {}, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {} });
 const ctx = { stack: { push: layer => layers.push(layer), removeLayer: layer => { const i = layers.indexOf(layer); if (i >= 0) { layers.splice(i, 1); layer.onRemoved?.(); } } }, actions: { requestRender() {} } };
 return { api: module.exports, ctx, menus, opened, priorities, timers, layers };
}
test('installed apps open phone settings directly with a three-second notice that cannot remove a newer layer', () => {
 const h = harness(), items = h.api.installedAppSettingsItems();
 assert.deepEqual(Array.from(items, item => item.label), ['T3', 'Other']); items[0].onSelect(h.ctx);
 assert.deepEqual(h.opened, ['app.t3']); assert.equal(h.layers[0].text, 'Check your phone to modify settings.');
 assert.equal(h.timers[0].ms, 3000); const newer = {}; h.layers.push(newer); h.timers[0].fn(); assert.deepEqual(h.layers, [newer]);
});
test('priorities start with behaviors, identify current owner and preserve declared app order', () => {
 const h = harness(), items = h.api.behaviorSettingsItems();
 assert.equal(items[0].label, 'Dictation'); assert.match(items[0].description, /In use: T3/); items[0].onSelect(h.ctx);
 assert.deepEqual(Array.from(h.menus[0].items, item => item.label), ['1. T3 · In use', '2. Other · Permission needed', 'Faceclaw default · fallback']);
 h.menus[0].items[1].onSelect(h.ctx, {}); h.menus[1].items[0].onSelect(h.ctx, {});
 assert.deepEqual(h.priorities, [['transcription', 'app.other/Service']]);
});
