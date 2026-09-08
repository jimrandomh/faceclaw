const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function harness(enabled = true) {
  class Stack {
    constructor() { this.layers = []; }
    push(layer) { this.layers.push(layer); }
    pop() { this.layers.pop(); }
    clearToBase() { this.layers = []; }
    isAtBase() { return !this.layers.length; }
    paint() { return ['menu']; }
    handleInput() {}
  }
  class Menu { constructor(title, items) { this.items = items; } }
  const modules = {
    '../graphics/image': {}, '../graphics/plane': { singlePlane: image => [image] },
    './gestures': { gestureHints: () => '' },
    './layers': { LayerStack: Stack, noopLayerActions: {} },
    './menu': { MenuLayer: Menu },
    './extension-settings': { effectiveExtension: () => enabled ? {} : undefined, appMenuPolicy: () => ({}), navigationPolicy: () => ({}) },
  };
  const context = { exports: {}, require: name => { assert.ok(name in modules, name); return modules[name]; } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/ui/window-menu.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, context);
  const sent = []; let chosen = 0;
  const menu = new context.exports.WindowMenu({ windowId: 'game', title: () => 'Game', post: msg => sent.push(msg), items: () => [{ label: 'Move', onSelect: ctx => { ctx.stack.pop(); chosen++; } }, { label: 'Disabled', disabled: true, onSelect: () => chosen++ }], paintBase: () => 'base', size: { width: 576, height: 260 }, isFocused: () => true });
  return { menu, sent, chosen: () => chosen, api: context.exports, Stack };
}
test('worker menus retain pause state and consume only their current selection', async () => {
  const h = harness(); h.menu.open(); const request = h.sent.find(item => item.type === 'present-app-menu');
  assert.ok(request); assert.equal(h.menu.isOpen(), true);
  assert.deepEqual(Array.from(h.menu.paint()), ['base']);
  await h.menu.handleInput({ type: 'app-menu-selection', menuId: request.menuId + 1, index: 0 });
  assert.equal(h.chosen(), 0); assert.equal(h.menu.isOpen(), true);
  await h.menu.handleInput({ type: 'app-menu-selection', menuId: request.menuId, index: 0 });
  assert.equal(h.chosen(), 1); assert.equal(h.menu.isOpen(), false);
  await h.menu.handleInput({ type: 'app-menu-selection', menuId: request.menuId, index: 0 });
  assert.equal(h.chosen(), 1);
});
test('unavailable presentation returns to the host menu, dismissal resumes the app', async () => {
  const h = harness(); h.menu.open(); const id = h.sent[0].menuId;
  await h.menu.handleInput({ type: 'app-menu-fallback', menuId: id });
  assert.deepEqual(Array.from(h.menu.paint()), ['menu']);
  const other = harness(); other.menu.open();
  await other.menu.handleInput({ type: 'app-menu-closed', menuId: other.sent[0].menuId });
  assert.equal(other.menu.isOpen(), false); assert.equal(other.chosen(), 0);
});
test('disabled items cannot run and no provider preserves host rendering', async () => {
  const h = harness(); h.menu.open();
  await h.menu.handleInput({ type: 'app-menu-selection', menuId: h.sent[0].menuId, index: 1 });
  assert.equal(h.chosen(), 0);
  const base = harness(false); base.menu.open(); assert.equal(base.sent.length, 0);
  assert.deepEqual(Array.from(base.menu.paint()), ['menu']);
});

test('async in-process selection keeps its backing menu until the callback settles', async () => {
  const h = harness(); let presented, release;
  h.api.configureAppMenuPresenter((_id, _title, items, closed) => { presented = { items, closed }; return true; });
  const stack = new h.Stack(), base = {}, menu = {};
  stack.push(base); stack.push(menu);
  const pending = new Promise(resolve => release = resolve);
  h.api.presentAppMenu('app', 'Actions', [{ label: 'Async action', onSelect: async ctx => { await pending; ctx.stack.pop(); } }], menu,
    { stack, actions: { requestRender() {} } }, () => { const index = stack.layers.indexOf(menu); if (index >= 0) stack.layers.splice(index, 1); });
  presented.items[0].onSelect(); presented.closed();
  assert.equal(stack.layers.length, 2);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(stack.layers, [base]);
});
