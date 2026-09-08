const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function harness({ awake = true, protectedFlow = false } = {}) {
  const source = ts.createSourceFile('controller.ts', fs.readFileSync('app/g2/dashboard-controller.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const wanted = new Set(['showExtensionSurface', 'closeExtensionSurface', 'notificationReplyReturn']);
  let methods;
  function visit(node) { if (ts.isClassDeclaration(node)) { const found = node.members.filter(m => wanted.has(m.name?.getText(source))); if (found.length === 3) methods = found.map(m => m.getText(source)); } ts.forEachChild(node, visit); }
  visit(source); assert.equal(methods.length, 3);
  const timers = new Map(); let timerId = 0, layer, wakes = 0, sleeps = 0, foreground = 'notes';
  const shell = {
    canShowExtensionOverlay: () => !protectedFlow && !layer,
    isScreenOn: () => awake,
    wake: () => { awake = true; wakes++; },
    sleep: () => { awake = false; sleeps++; },
    sleepAtAppRoot: () => { awake = false; sleeps++; },
    foregroundWindow: () => ({windowId: foreground}),
    hasOverlay: () => !!layer || protectedFlow,
    showExtensionOverlay: next => { layer = next; return true; },
    closeExtensionOverlay: target => { if (target === layer) layer = undefined; target.closed(); },
    getWindows: () => [],
  };
  class Surface {
    constructor(input, resized, closed, heightMode, opaque, alignTop) { Object.assign(this, { input, resized, closed, heightMode, opaque, alignTop }); }
  }
  const context = { shell, ExtensionLayer: Surface, setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id) };
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(`class Harness { ${methods.join('\n')} }; globalThis.Harness = Harness;`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
  const controller = new context.Harness(); Object.assign(controller, { extensionSurfaces: new Map(), glassesLocked: false, phase: 'connected', ensureEvenHubSessionActive() {}, requestShellRender() {}, externalApps: { extensions: { surfaceInput() {}, openSurface() {}, setSurfaceVisibility() {}, closeSurface() {} } } });
  return { controller, layer: () => layer, timers, awake: () => awake, wakes: () => wakes, sleeps: () => sleeps, foreground: id => foreground = id, protect: value => protectedFlow = value, expire() { const current = [...timers.values()]; timers.clear(); current.forEach(fn => fn()); } };
}
test('arrival previews preserve the original sleep origin across replacement', () => {
  const h = harness({ awake: false });
  h.controller.showExtensionSurface('ui.notifications', 'example/Service', 'first');
  assert.equal(h.wakes(), 1); assert.equal(h.layer().opaque, true); assert.equal(h.layer().heightMode, 'medium');
  h.controller.showExtensionSurface('ui.notifications', 'example/Service', 'second');
  assert.equal(h.wakes(), 1); assert.equal(h.timers.size, 2); // Preview deadline plus deferred replacement cleanup.
  h.expire(); assert.equal(h.awake(), false); assert.equal(h.sleeps(), 1); assert.equal(h.layer(), undefined);
});
test('awake previews retain the backdrop and protected flows never wake or open', () => {
  const awake = harness(); awake.controller.showExtensionSurface('ui.notifications', 'example/Service', 'key');
  assert.equal(awake.layer().opaque, false); awake.expire(); assert.equal(awake.awake(), true);
  const busy = harness({ awake: false, protectedFlow: true }); busy.controller.showExtensionSurface('ui.notifications', 'example/Service', 'key');
  assert.equal(busy.wakes(), 0); assert.equal(busy.layer(), undefined); assert.equal(busy.timers.size, 0);
});
test('opening content cancels timeout and new arrivals cannot replace the reader', () => {
  const h = harness({ awake: false }); h.controller.showExtensionSurface('ui.notifications', 'example/Service', 'first');
  const reader = h.layer(); assert.equal(reader.alignTop, true); reader.input({ type: 'click' }); assert.equal(reader.alignTop, false);
  assert.equal(reader.opaque, true); assert.equal(h.timers.size, 0);
  h.controller.showExtensionSurface('ui.notifications', 'example/Service', 'second');
  assert.equal(h.layer(), reader); h.controller.closeExtensionSurface('ui.notifications'); assert.equal(h.awake(), false);
});
test('dismissing a preview restores sleep; explicitly opening inbox stays open', () => {
  const h = harness({ awake: false }); h.controller.showExtensionSurface('ui.notifications', 'example/Service', 'key');
  h.layer().input({ type: 'scroll-down' }); h.controller.closeExtensionSurface('ui.notifications'); assert.equal(h.awake(), false);
  const inbox = harness(); inbox.controller.showExtensionSurface('ui.notifications', 'example/Service', 'inbox');
  assert.equal(inbox.timers.size, 0); assert.equal(inbox.layer().opaque, true);
});

test('reply handoff stays awake during capture and successful completion restores its sleep origin',()=>{
 const h=harness({awake:false});h.controller.showExtensionSurface('ui.notifications','example/Service','key');h.layer().input({type:'click'});
 const restore=h.controller.notificationReplyReturn();h.controller.closeExtensionSurface('ui.notifications',false);assert.equal(h.awake(),true);restore();assert.equal(h.awake(),false);
});
test('late reply completion cannot put a new app or protected overlay to sleep',()=>{
 for(const change of [h=>h.foreground('other'),h=>h.protect(true)]) {
  const h=harness({awake:false});h.controller.showExtensionSurface('ui.notifications','example/Service','key');const restore=h.controller.notificationReplyReturn();h.controller.closeExtensionSurface('ui.notifications',false);change(h);restore();assert.equal(h.awake(),true);
 }
});
