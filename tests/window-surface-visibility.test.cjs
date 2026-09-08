const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function harness() {
  const source = ts.createSourceFile('controller.ts', fs.readFileSync('app/g2/dashboard-controller.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  let method;
  function visit(node) {
    if (ts.isMethodDeclaration(node) && node.name?.getText(source) === 'configureWindowSurface') method = node.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source); assert.ok(method);
  const windows = [{ windowId: 'launcher', appId: 'launcher', surfaceId: 'window:launcher' }, { windowId: 'calendar', appId: 'calendar', surfaceId: 'window:calendar' }];
  let foreground = windows[0]; const configured = [], visibility = [], pending = [];
  const display = {
    configureSurface(id) { configured.push(id); return new Promise(resolve => pending.push(resolve)); },
    async setSurfaceVisible(id, visible) { visibility.push([id, visible]); },
  };
  const context = { shell: { getWindows: () => windows, foregroundWindow: () => foreground }, appViewportRect: () => ({ x: 0, y: 0, width: 576, height: 260 }) };
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(`class Harness { ${method} }; globalThis.Harness = Harness;`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
  const controller = new context.Harness(); controller.display = display;
  return { controller, visibility, focus(index) { foreground = windows[index]; }, finish() { pending.shift()(); } };
}

test('delayed geometry setup cannot make the old launcher cover a newly focused window', async () => {
  const h = harness();
  const setup = h.controller.configureWindowSurface('window:launcher', 'min');
  h.focus(1); h.finish(); await setup;
  assert.deepEqual(h.visibility, [['window:launcher', false]]);
});

test('a window focused during geometry setup remains visible after setup completes', async () => {
  const h = harness();
  const setup = h.controller.configureWindowSurface('window:calendar', 'min');
  h.focus(1); h.finish(); await setup;
  assert.deepEqual(h.visibility, [['window:calendar', true]]);
});
