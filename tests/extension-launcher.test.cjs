const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function harness() {
  let winner, changed, on = true; const calls = [], base = [];
  const platform = { feature: () => winner, openSurface: (...args) => { calls.push(['open', ...args]); return true; }, setSurfaceVisibility: (...args) => calls.push(['visibility', ...args]), surfaceInput: (...args) => calls.push(['input', ...args]), surfacePointer: (...args) => calls.push(['pointer', ...args]) };
  const modules = { '../../apps/external/extension-platform': { extensionPlatform: () => platform }, '../extension-settings': { onEffectiveExtensionsChanged: fn => changed = fn }, './geometry': { appViewportSize: () => ({ width: 576, height: 260 }) }, './shell': { shell: { isScreenOn: () => on } } };
  const context = { exports: {}, require: name => { assert.ok(name in modules, name); return modules[name]; } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/ui/shell/extension-launcher.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
  const window = { hitTest: () => { base.push('hitTest'); return true; }, handleInput: () => base.push('input'), requestRender: () => base.push('render'), relayout: () => base.push('relayout'), setForeground: () => {}, setScreenOn: () => {} };
  context.exports.attachLauncherSurface(window);
  return { window, calls, base, setWinner(value) { winner = value; changed(); }, off() { on = false; window.setScreenOn(false); } };
}
test('the pinned host launcher resumes immediately when its provider disappears', () => {
  const h = harness(); h.window.requestRender(); assert.deepEqual(h.base, ['render']);
  h.setWinner({ component: 'example/Service', generation: 1 }); h.window.handleInput({ type: 'click' }, 1);
  assert.equal(h.calls.filter(call => call[0] === 'open').length, 1);
  assert.equal(h.calls.at(-1)[0], 'input');
  h.setWinner(undefined); h.window.handleInput({ type: 'click' }, 2);
  assert.deepEqual(h.base, ['render', 'render', 'input']);
});
test('provider generation and visibility are independent of the original window identity', () => {
  const h = harness(); const original = h.window;
  h.setWinner({ component: 'example/Service', generation: 1 }); h.window.requestRender();
  assert.equal(h.calls.filter(call => call[0] === 'open').length, 1);
  h.setWinner({ component: 'other/Service', generation: 2 });
  assert.equal(h.calls.filter(call => call[0] === 'open').length, 2); assert.equal(h.window, original);
  h.window.setForeground(false); h.off();
  assert.deepEqual(h.calls.at(-1), ['visibility', 'ui.launcher', false, false]);
});

test('mirror touches use the visible provider instead of hidden host grid cells', () => {
  const h = harness();
  h.setWinner({ component: 'example/Service', generation: 1 });
  assert.equal(h.window.hitTest(42, 60), true);
  assert.deepEqual(h.calls.at(-1), ['pointer', 'ui.launcher', 42, 60, 576, 260]);
  assert.ok(!h.base.includes('hitTest'));
  h.setWinner(undefined);
  assert.equal(h.window.hitTest(42, 60), true);
  assert.equal(h.base.at(-1), 'hitTest');
});

test('unrelated effective settings updates do not reopen the same launcher surface', () => {
  const h=harness();
  h.setWinner({component:'example/Service',generation:4});
  h.setWinner({component:'example/Service',generation:4});
  assert.equal(h.calls.filter(call=>call[0]==='open').length,1);
});
