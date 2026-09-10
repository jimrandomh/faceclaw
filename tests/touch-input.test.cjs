const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const js = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

// Run the actual decoder declarations without loading the Android shell.
function decoder() {
  const source = ts.createSourceFile('shell.ts', read('app/ui/shell/shell.ts'), ts.ScriptTarget.Latest, true);
  const names = new Set(['rawInputEventToPayload', 'eventSourceToString', 'scrollEvent']);
  const declarations = source.statements.filter((s) => ts.isFunctionDeclaration(s) && names.has(s.name?.text));
  assert.equal(declarations.length, names.size);
  const context = { exports: {} };
  vm.createContext(context);
  vm.runInContext(js(read('app/g2/events.ts')), context);
  Object.assign(context, context.exports);
  vm.runInContext(js(declarations.map((s) => s.getText(source)).join('\n')), context);
  return context;
}

test('wire edges require explicit left/right temple provenance', () => {
  const d = decoder();
  for (const [key, source] of [['TOUCH_EVENT_FROM_GLASSES_L', 'left-arm'], ['TOUCH_EVENT_FROM_GLASSES_R', 'right-arm']]) {
    const eventSource = d.EventSourceType[key];
    for (const [eventType, type] of [[12, 'touch-press'], [13, 'touch-release']]) {
      const event = d.rawInputEventToPayload({ kind: 'sys-event', eventSource, eventType });
      assert.equal(event.type, type);
      assert.equal(event.source, source);
    }
    assert.equal(d.rawInputEventToPayload({ kind: 'sys-event', eventSource, eventType: 0 }).type, 'click');
  }
  for (const eventSource of [undefined, -1, 99, d.EventSourceType.TOUCH_EVENT_FROM_RING]) {
    assert.equal(d.rawInputEventToPayload({ kind: 'sys-event', eventSource, eventType: 12 }).type, 'unknown');
  }
});

function worker() {
  const noop = () => {};
  const modules = {
    '@nativescript/core/globals': {},
    '../../graphics/image': {}, '../../graphics/plane': {}, '../../graphics/glyph-wire': {},
    '../../graphics/bdffont': { getFont: noop },
    '../../graphics/ui-fonts': { getDefaultSmallFont: noop },
    '../../native/frame-timings': { finishFrame: noop, logFrame: noop },
    '../../native/active-display': {},
    '../../native/settings-store': { getStringSetting: () => '0', setStringSetting: noop },
    '../../ui/sound-effects': {}, '../../ui/window-menu': {},
    '../../ui/gestures': { directionalFallback: (event) => event },
    '../../util/numeric-util': { clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)) },
  };
  const context = {
    exports: {}, console, Date, setInterval: () => 1, clearInterval: noop,
    global: { postMessage: noop },
    require: (name) => { assert.ok(name in modules, name); return modules[name]; },
  };
  vm.createContext(context);
  vm.runInContext(js(read('app/apps/pinball/pinball-app.worker.ts')) + `
    // Stub platform output only; exercise real worker input, physics and lifecycle.
    renderAndSubmit = () => {};
    playSfx = () => {};
    exports.harness = { windows, stepFlippers, resetGame };
  `, context);
  const message = (data) => context.global.onmessage({ data });
  message({ type: 'open-window', windowId: 'test', surfaceId: 'test', title: 'test', viewport: { width: 640, height: 480 } });
  message({ type: 'foreground', windowId: 'test', foreground: true, focused: true });
  const w = context.exports.harness.windows.get('test');
  w.ballState = 'live';
  const input = (type, source = 'left-arm') => message({ type: 'input', windowId: 'test', focused: true, frameId: 1, event: { type, source, timestampMs: Date.now() } });
  return { w, input, message, ...context.exports.harness };
}

test('pinball responds on contact, holds independently, and releases before tap', () => {
  const h = worker();
  h.input('touch-press');
  assert.equal(h.w.flippers[0].state, 'rising');
  assert.equal(h.w.flippers[1].state, 'rest');
  h.stepFlippers(h.w, 1);
  h.w.flippers[0].holdUntilMs = 0;
  h.stepFlippers(h.w, 1);
  assert.equal(h.w.flippers[0].state, 'hold');
  h.input('touch-press', 'right-arm');
  h.input('touch-release');
  assert.equal(h.w.flippers[0].state, 'falling');
  assert.equal(h.w.flippers[1].touchHeld, true);
  h.input('click');
  assert.equal(h.w.flippers[0].state, 'falling');
  h.input('touch-release', 'right-arm');
  assert.equal(h.w.flippers[1].state, 'falling');
});

test('pinball retains old firmware/ring controls and plunger click launch', () => {
  const h = worker();
  h.input('click');
  assert.ok(h.w.flippers.every((f) => f.state === 'rising'));
  h.resetGame(h.w);
  h.input('touch-press');
  h.input('touch-release');
  assert.equal(h.w.ballState, 'ready');
  h.input('click');
  assert.equal(h.w.ballState, 'live');
  h.input('click', 'ring');
  assert.ok(h.w.flippers.every((f) => f.state === 'rising'));
});

test('pinball clears held contacts on pause, focus loss, screen-off and menus', () => {
  for (const cancel of [
    (h) => h.input('double-click', 'ring'),
    (h) => h.input('system-menu-opened'),
    (h) => h.message({ type: 'foreground', windowId: 'test', foreground: false, focused: false }),
    (h) => h.message({ type: 'render', windowId: 'test', focused: false }),
    (h) => h.message({ type: 'screen', on: false }),
  ]) {
    const h = worker();
    h.input('touch-press');
    cancel(h);
    assert.equal(h.w.flippers[0].touchHeld, false);
    assert.equal(h.w.flippers[0].state, 'falling');
  }
});
