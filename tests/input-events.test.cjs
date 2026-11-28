const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { bordered, unbordered } = require('./helpers/viewport.cjs');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const js = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
function load(file, modules = {}) {
  const context = { exports: {}, console, require(name) {
    assert.ok(name in modules, name); return modules[name];
  } };
  vm.runInNewContext(js(read(file)), context);
  return context.exports;
}
const monitor = load('app/ui/input-monitor.ts');
const event = (type, timestampMs = 1000) => ({ type, source: 'ring', timestampMs });

function shellDeclarations() {
  const source = ts.createSourceFile('shell.ts', read('app/ui/shell/shell.ts'), ts.ScriptTarget.Latest, true);
  const names = new Set(['rawInputEventToInputEvent', 'rawInputEventToPayload', 'eventSourceToString', 'scrollEvent']);
  const declarations = source.statements.filter((s) => ts.isFunctionDeclaration(s) && names.has(s.name?.text));
  assert.equal(declarations.length, names.size);
  const switcherSwipes = source.statements.find((s) => ts.isVariableStatement(s) &&
    s.declarationList.declarations.some((d) => d.name.getText(source) === 'SWITCHER_SWIPES'));
  const shell = source.statements.find((s) => ts.isClassDeclaration(s) && s.name?.text === 'Shell');
  const methods = shell.members.filter((s) => [
    'receiveInput', 'routeInput', 'handleSidebarInput', 'startNeuralBandDictation', 'stopNeuralBandDictation',
    'openVoiceDialog', 'resetNeuralBandInput', 'hitTestOverlay',
  ].includes(s.name?.getText(source)));
  const context = { exports: {}, acceptInput: monitor.acceptInput, runWithFrame: (_frameId, fn) => fn(),
    switcherPosition: () => 'bottom',
    ...load('app/ui/gestures.ts'),
    makeInputEvent: (payload) => ({ ...payload, timestampMs: 12345678 }),
    ...load('app/g2/events.ts') };
  vm.createContext(context);
  vm.runInContext(js([...declarations, switcherSwipes].map((s) => s.getText(source)).join('\n') +
    '\nexport class Shell {\n' + methods.map((s) => s.getText(source)).join('\n') + '\n}'), context);
  return context;
}

function makeTestLayerStack(base) {
  const { LayerStack, noopLayerActions } = load('app/ui/layers.ts', {
    '../graphics/image': require('../.test-build/app/graphics/image.js'),
    '../graphics/plane': require('../.test-build/app/graphics/plane.js'),
    '../graphics/screen-size': { screenWidth: () => 576, screenHeight: () => 288 },
    '../native/frame-timings': { spanCurrent: (_name, fn) => fn() },
    './gestures': load('app/ui/gestures.ts'),
    './viewport': require('../.test-build/app/ui/viewport.js'),
  });
  return new LayerStack(base, noopLayerActions, { width: 576, height: 288 });
}

test('a positional click reaches the top app overlay and never passes through a miss', async () => {
  const hits = [];
  const stack = makeTestLayerStack({ hitTest: (x, y) => { hits.push(['base', x, y]); return false; } });
  stack.push({ hitTest: (x, y) => { hits.push(['menu', x, y]); return true; } });
  stack.push({
    hitTest(x, y) {
      hits.push(['submenu', x, y]);
      stack.pop();
      return false;
    },
  });
  assert.equal(await stack.hitTest(20, 35), true, 'a closing overlay owns even an unhandled point');
  assert.deepEqual(hits, [['submenu', 20, 35]]);
  assert.equal(await stack.hitTest(20, 35), true);
  stack.push({});
  assert.equal(await stack.hitTest(20, 35), true, 'an overlay without geometry blocks the menu below');
  assert.deepEqual(hits, [['submenu', 20, 35], ['menu', 20, 35]]);
  stack.clearToBase();
  assert.equal(await stack.hitTest(20, 35), false);
  assert.deepEqual(hits, [['submenu', 20, 35], ['menu', 20, 35], ['base', 20, 35]]);
});

test('panel taps reach shell overlays before the app and keep mirror fallback only outside overlays', async () => {
  const source = ts.createSourceFile('dashboard-controller.ts', read('app/g2/dashboard-controller.ts'), ts.ScriptTarget.Latest, true);
  const controller = source.statements.find((s) => ts.isClassDeclaration(s) && s.name?.text === 'DashboardController');
  const method = controller.members.find((s) => s.name?.getText(source) === 'handlePanelTap');
  const { exports: { Shell } } = shellDeclarations();
  const shell = new Shell(), calls = [];
  const stack = makeTestLayerStack({ hitTest() { assert.fail('shell base should not get an overlay click'); } });
  stack.push({ hitTest: (x, y) => { calls.push(['overlay', x, y]); return y === 50; } });
  Object.assign(shell, {
    screenOn: true, activeVoiceLayer: null, stack,
    hasOverlay: () => !stack.isAtBase(), noteUserActivity() {}, syncInputFocus() {},
    getFocus: () => 'window', focusStatusItemAt: () => false,
    foregroundWindow: () => ({ hitTest: (x, y, tapSource) => { calls.push(['window', x, y, tapSource]); return false; } }),
  });
  const context = { exports: {}, shell, sidebarStripVisible: () => false,
    appViewportRect: () => ({ x: 15, y: 10, width: 100, height: 80 }) };
  vm.runInNewContext(js('export class Controller { ' + method.getText(source) + ' }'), context);
  const c = new context.exports.Controller();
  Object.assign(c, {
    canUseNeuralBandModalities: () => true, appendLog() {},
    requestShellRender: () => calls.push(['render']),
    injectSyntheticRingInput: (type, source) => calls.push([type, source]),
  });
  await c.handlePanelTap(40, 50, 'neural-band');
  await c.handlePanelTap(40, 60, 'mirror');
  assert.deepEqual(calls, [['overlay', 40, 50], ['render'], ['overlay', 40, 60], ['render']]);
  calls.length = 0;
  stack.clearToBase();
  await c.handlePanelTap(40, 50, 'neural-band');
  await c.handlePanelTap(40, 50, 'mirror');
  assert.deepEqual(calls, [['window', 25, 40, 'neural-band'], ['window', 25, 40, 'mirror'], ['click', 'watch']]);
});

test('new SysEvent decodes independently of click, double-tap, hold and release', () => {
  const d = shellDeclarations();
  for (const source of [0, 2]) {
    const decoded = d.rawInputEventToPayload({ kind: 'sys-event', eventType: 14, eventSource: source });
    assert.equal(decoded.type, 'ring-press'); assert.equal(decoded.source, 'ring');
  }
  // Synthetic watch touch-down (TOUCH_EVENT_FROM_WATCH, never sent by firmware).
  const watch = d.rawInputEventToPayload({ kind: 'sys-event', eventType: 14, eventSource: 4 });
  assert.equal(watch.type, 'ring-press'); assert.equal(watch.source, 'watch');
  for (const source of [1, 3, 99, undefined]) {
    assert.equal(d.rawInputEventToPayload({ kind: 'sys-event', eventType: 14, eventSource: source }).type, 'unknown');
  }
  for (const [id, type] of [[0,'click'],[3,'double-click'],[9,'long-press'],[10,'long-press-release'],[11,'short-then-long-press']]) {
    assert.equal(d.rawInputEventToPayload({ kind: 'sys-event', eventType: id, eventSource: 2 }).type, type);
  }
});

test('press is observed before routing and does not wake, operate shell menus or replace hold state', async () => {
  const { exports: { Shell } } = shellDeclarations();
  for (const screenOn of [true, false]) for (const focus of ['window', 'sidebar']) for (const atBase of [true, false]) {
    const s = new Shell(), seen = [], delivered = [];
    const unsubscribe = monitor.addInputListener((e) => seen.push(e));
    Object.assign(s, { screenOn, focus, stack: { isAtBase: () => atBase },
      foregroundWindow: () => ({ handleInput(e) { assert.equal(seen.length, 1); delivered.push(e); } }),
      syncInputFocus() {}, lastInput: event('long-press'), lastInputAtMs: 123 });
    try {
      const result = await s.receiveInput(event('ring-press'));
      assert.equal(result.shell, false);
      assert.equal(delivered.length, Number(screenOn && focus === 'window' && atBase));
      assert.equal(seen.length, 1);
      assert.equal(s.lastInput.type, 'long-press'); assert.equal(s.lastInputAtMs, 123);
    } finally { unsubscribe(); }
  }
});

test('Neural Band Back is inert at the switcher root and while the display sleeps', async () => {
  const { exports: { Shell } } = shellDeclarations();
  for (const screenOn of [true, false]) {
    const s = new Shell();
    Object.assign(s, {
      screenOn, lastInput: null, focus: 'sidebar', stack: { isAtBase: () => true },
      syncInputFocus() {}, cancelEscapeMenuTimer() {},
      sleep() { assert.fail('Back put the display to sleep'); },
      wake() { assert.fail('Back woke the display'); },
    });
    const result = await s.receiveInput({ ...event('back'), source: 'neural-band' });
    assert.equal(result.shell, false);
    assert.equal(result.window, false);
  }
});

test('Neural Band Back reaches an open overlay or app using the existing back gesture', async () => {
  const { exports: { Shell } } = shellDeclarations();
  for (const overlayOpen of [true, false]) {
    const s = new Shell(), overlayInputs = [], appInputs = [];
    Object.assign(s, {
      screenOn: true, lastInput: null, focus: 'window',
      stack: { isAtBase: () => !overlayOpen, handleInput: input => overlayInputs.push(input) },
      foregroundWindow: () => ({ handleInput: input => appInputs.push(input) }),
      syncInputFocus() {}, cancelEscapeMenuTimer() {},
    });
    await s.receiveInput({ ...event('back'), source: 'neural-band' });
    assert.deepEqual(overlayInputs.map(input => input.type), overlayOpen ? ['double-click'] : []);
    assert.deepEqual(appInputs.map(input => input.type), overlayOpen ? [] : ['double-click']);
  }
});

test('Neural Band horizontal swipes preserve spatial motion and never confirm ordinary prompts', async () => {
  const { exports: { Shell } } = shellDeclarations();
  const s = new Shell();
  const delivered = [];
  const window = { acceptsDirectional: true, handleInput(input) { delivered.push(input); } };
  Object.assign(s, {
    screenOn: true, focus: 'window', foregroundWindow: () => window,
    stack: { isAtBase: () => true }, syncInputFocus() {}, cancelEscapeMenuTimer() {},
  });
  const left = { ...event('swipe-left'), source: 'neural-band' };
  const right = { ...event('swipe-right'), source: 'neural-band' };
  await s.receiveInput(left);
  await s.receiveInput(right);
  window.acceptsDirectional = false;
  await s.receiveInput(left);
  await s.receiveInput(right);
  s.focus = 'sidebar';
  const steps = [];
  s.moveSelection = (step) => steps.push(step);
  await s.receiveInput(left);
  await s.receiveInput(right);
  assert.deepEqual(delivered.map(input => [input.type, input.source]), [
    ['swipe-left', 'neural-band'], ['swipe-right', 'neural-band'],
    ['scroll-up', 'neural-band'], ['scroll-down', 'neural-band'],
  ]);
  assert.deepEqual(steps, [-1, 1]);
});

test('Neural Band index hold releases only the original dictation and cancels on link loss', async () => {
  const { exports: { Shell } } = shellDeclarations();
  const s = new Shell();
  const delivered = [];
  const holdToTalk = { holdToTalk: true, handleInput(input) { delivered.push(input.type); } };
  let foreground = holdToTalk;
  Object.assign(s, {
    screenOn: true, focus: 'window', config: {}, foregroundWindow: () => foreground,
    stack: { isAtBase: () => true, remove() { assert.fail('unrelated voice capture removed'); } },
    syncInputFocus() {}, cancelEscapeMenuTimer() {},
  });
  const band = (type) => ({ ...event(type), source: 'neural-band' });
  await s.receiveInput(band('index-hold-end'));
  await s.receiveInput(band('index-hold-start'));
  await s.receiveInput(band('index-hold-start'));
  await s.receiveInput(band('index-hold-end'));
  await s.receiveInput(band('index-hold-end'));
  await s.receiveInput(band('index-hold-start'));
  await s.receiveInput(band('index-hold-cancel'));
  await s.receiveInput(band('index-hold-start'));
  foreground = { handleInput() { assert.fail('hold release leaked to a different app'); } };
  await s.receiveInput(band('index-hold-end'));
  assert.deepEqual(delivered, [
    'long-press', 'long-press-release', 'long-press', 'long-press-cancel', 'long-press', 'long-press-cancel',
  ]);
});

test('Neural Band release during microphone preparation prevents a late recording', async () => {
  const { exports: { Shell } } = shellDeclarations();
  const s = new Shell();
  let allowMicrophone;
  const prepareVoiceCapture = () => new Promise(resolve => { allowMicrophone = resolve; });
  let opened = 0;
  Object.assign(s, {
    screenOn: true, focus: 'window', config: { prepareVoiceCapture, requestShellRender() {} },
    foregroundWindow: () => undefined, stack: { isAtBase: () => true },
    syncInputFocus() {}, cancelEscapeMenuTimer() {}, openVoiceDialogNow() { opened++; },
  });
  const band = (type) => ({ ...event(type), source: 'neural-band' });
  await s.receiveInput(band('index-hold-start'));
  assert.equal(typeof allowMicrophone, 'function');
  await s.receiveInput(band('index-hold-end'));
  allowMicrophone(true);
  await Promise.resolve();
  assert.equal(opened, 0);
});

test('Neural Band shell dictation finalizes on release and discards on cancellation', async () => {
  const { exports: { Shell } } = shellDeclarations();
  const s = new Shell();
  const actions = [];
  Object.assign(s, {
    screenOn: true, focus: 'window', config: { requestShellRender() {} },
    foregroundWindow: () => undefined, stack: {
      isAtBase: () => true,
      remove(layer) { assert.equal(layer, s.activeVoiceLayer); s.activeVoiceLayer = null; actions.push('discard'); },
    },
    openVoiceDialogNow() {
      this.activeVoiceLayer = { endCapture: () => { this.activeVoiceLayer = null; actions.push('finish'); } };
      return this.activeVoiceLayer;
    },
    syncInputFocus() {}, cancelEscapeMenuTimer() {},
  });
  const band = (type) => ({ ...event(type), source: 'neural-band' });
  await s.receiveInput(band('index-hold-start'));
  assert.ok(s.activeVoiceLayer);
  await s.receiveInput(band('index-hold-end'));
  await s.receiveInput(band('index-hold-start'));
  assert.ok(s.activeVoiceLayer);
  await s.receiveInput(band('index-hold-cancel'));
  assert.deepEqual(actions, ['finish', 'discard']);
});

test('Neural Band middle shortcuts only focus the switcher, launcher, or system menu', async () => {
  const { exports: { Shell } } = shellDeclarations();
  const s = new Shell();
  const actions = [];
  let overlay = false;
  Object.assign(s, {
    screenOn: true, focus: 'window', foregroundWindow: () => undefined,
    stack: { isAtBase: () => !overlay, handleInput() { assert.fail('shortcut activated overlay'); } },
    syncInputFocus() {}, cancelEscapeMenuTimer() {}, yieldFocusToSidebar() { actions.push('switcher'); },
    focusWindow(id) { actions.push(id); }, openEscapeMenu() { actions.push('system-menu'); },
  });
  for (const atOverlay of [false, true]) {
    overlay = atOverlay;
    for (const type of ['middle-double', 'middle-triple', 'middle-hold-start', 'middle-hold-end', 'middle-hold-cancel']) {
      await s.receiveInput({ ...event(type), source: 'neural-band' });
    }
  }
  assert.deepEqual(actions, ['switcher', 'launcher', 'system-menu']);
});

test('physical R1 double-click still sleeps from the switcher and wakes the display', async () => {
  const { exports: { Shell } } = shellDeclarations();
  const s = new Shell();
  Object.assign(s, {
    screenOn: true, lastInput: null, focus: 'sidebar', stack: { isAtBase: () => true },
    syncInputFocus() {}, cancelEscapeMenuTimer() {}, userWakeFocus: () => 'sidebar',
    sleep() { this.screenOn = false; },
    wake() { this.screenOn = true; },
  });
  await s.receiveInput(event('double-click'));
  assert.equal(s.screenOn, false);
  await s.receiveInput(event('double-click'));
  assert.equal(s.screenOn, true);
});

test('a mapped Band double click goes back in an app and sleeps from the switcher', async () => {
  const { exports: { Shell } } = shellDeclarations();
  const s = new Shell();
  Object.assign(s, {
    screenOn: true, focus: 'window', stack: { isAtBase: () => true },
    syncInputFocus() {}, cancelEscapeMenuTimer() {},
    foregroundWindow: () => ({
      handleInput: async (input) => {
        assert.equal(input.type, 'double-click');
        s.focus = 'sidebar';
      },
    }),
    sleep() { this.screenOn = false; },
  });
  const gesture = { ...event('double-click'), source: 'neural-band' };
  await s.receiveInput(gesture);
  assert.equal(s.focus, 'sidebar');
  assert.equal(s.screenOn, true);
  await s.receiveInput(gesture);
  assert.equal(s.screenOn, false);
});

test('Neural Band routes on a locked phone and consumes the first Select as a glasses wake', async () => {
  const source = ts.createSourceFile('dashboard-controller.ts', read('app/g2/dashboard-controller.ts'), ts.ScriptTarget.Latest, true);
  const inputType = source.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'neuralBandInputType');
  const controller = source.statements.find((s) => ts.isClassDeclaration(s) && s.name?.text === 'DashboardController');
  const method = controller.members.find((s) => s.name?.getText(source) === 'handleNeuralBandAction');
  assert.ok(method, 'Neural Band must enter through the controller input pipeline');
  let screenOn = true;
  const context = { exports: {}, shell: { isScreenOn: () => screenOn }, ...load('app/g2/events.ts') };
  vm.runInNewContext(js(inputType.getText(source) + '\nexport class Controller { ' + method.getText(source) + ' }'), context);

  const received = [], c = new context.exports.Controller();
  Object.assign(c, {
    phase: 'connected', phoneLocked: true, glassesLocked: false,
    isPreviewDisplayActive: () => false,
    neuralBandModalities: { stopHandwriting: () => false },
    handleInputEvent: async input => received.push(input),
  });
  for (const action of ['scroll-up', 'scroll-down', 'select', 'back', 'dial-up', 'dial-down', 'swipe-left', 'swipe-right']) {
    await c.handleNeuralBandAction(action);
  }
  assert.deepEqual(received.map(input => [input.kind, input.action]), [
    ['neural-band', 'scroll-up'], ['neural-band', 'scroll-down'], ['neural-band', 'select'], ['neural-band', 'back'],
    ['neural-band', 'dial-up'], ['neural-band', 'dial-down'], ['neural-band', 'swipe-left'], ['neural-band', 'swipe-right'],
  ]);
  assert.deepEqual(received.map(input => context.neuralBandInputType(input.action)), [
    'scroll-up', 'scroll-down', 'click', 'back', 'scroll-up', 'scroll-down', 'scroll-up', 'scroll-down',
  ]);

  received.length = 0;
  screenOn = false;
  for (const action of ['scroll-up', 'scroll-down', 'back', 'select', 'double-click', 'screen-toggle']) {
    await c.handleNeuralBandAction(action);
  }
  assert.deepEqual(received.map(input => input.kind), ['display-wake', 'display-wake', 'display-wake']);

  received.length = 0;
  c.glassesLocked = true;
  await c.handleNeuralBandAction('select');
  assert.equal(received.length, 0);
  await c.handleNeuralBandAction('double-click');
  assert.deepEqual(received.map(input => input.action), ['double-click'], 'only explicit power controls reach the locked handler');
  received.length = 0;
  c.glassesLocked = false;
  c.phase = 'charging';
  await c.handleNeuralBandAction('select');
  assert.equal(received.length, 0);

  c.phase = 'connected';
  screenOn = true;
  let finishWake;
  c.evenHubResumePromise = new Promise(resolve => { finishWake = resolve; });
  const selectDuringWake = c.handleNeuralBandAction('select');
  assert.equal(received.length, 0, 'do not select a window during the display wake');
  finishWake(true);
  await selectDuringWake;
  assert.deepEqual(received, [], 'a selection during wake must not execute after waking');
});

test('bounded history preserves equal-time events, snapshots and arrival gaps; pause and clear work', () => {
  const log = new monitor.InputEventLog();
  const first = event('ring-press'); log.add(first); first.type = 'unknown';
  log.add(event('click')); log.add(event('double-click', 1250));
  assert.equal(log.entries[2].event.type, 'ring-press');
  assert.equal(log.entries[2].gapMs, null); assert.equal(log.entries[1].gapMs, 0);
  assert.equal(log.entries[0].gapMs, 250);
  log.paused = true; log.add(event('click')); assert.equal(log.count, 3);
  log.paused = false;
  for (let i = 0; i < 210; i++) log.add(event('click', 2000 + i));
  assert.equal(log.entries.length, 200); assert.equal(log.count, 213);
  log.clear(); log.add(event('ring-press')); assert.equal(log.count, 1); assert.equal(log.entries[0].gapMs, null);
  assert.equal(monitor.inputTimestamp(new Date(2026, 0, 2, 3, 4, 5, 6).getTime()), '03:04:05.006');
});

test('Input events captures while visible, pauses for history, and unsubscribes on removal', () => {
  const textwrap = load('app/graphics/textwrap.ts');
  const graphics = require('../.test-build/app/graphics/image.js');
  const { BdfFont } = load('app/graphics/bdffont.ts', { '@nativescript/core': {} });
  const font = BdfFont.parse(read('app/fonts/terminus/ter-u18n.bdf'));
  class RecordingImage extends graphics.GrayImage {
    texts = [];
    drawText(font, x, y, text, value) {
      this.texts.push({ x, y, text, width: font.measureText(text), height: font.lineHeight });
      super.drawText(font, x, y, text, value);
    }
  }
  const { InputEventsLayer } = load('app/apps/developer/input-events.ts', {
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => font },
    '../../graphics/image': { GrayImage: RecordingImage }, '../../graphics/textwrap': textwrap,
    '../../ui/input-monitor': monitor, '../../ui/menu': { drawListScrollbar() {} },
  });
  let visible = true, renders = 0, removed = 0, pops = 0;
  const layer = new InputEventsLayer(() => renders++, () => visible, () => removed++);
  let viewport = bordered(576, 260);
  const ctx = { stack: { getBaseSize: () => viewport,
    pop: () => pops++, popThrough: (page) => { assert.equal(page, layer); page.onRemoved(); } } };
  const inBounds = (image) => {
    for (const text of image.texts) {
      assert.ok(text.x >= 0 && text.x + text.width <= image.width, text.text);
      assert.ok(text.y >= 0 && text.y + text.height <= image.height, text.text);
    }
  };
  const at = (image, start) => image.texts.find(t => t.text.startsWith(start));
  try {
    for (const type of ['ring-press','click','ring-press','ring-press','double-click','long-press','long-press-release','short-then-long-press']) {
      const e = { ...event(type, 1000 + renders * 75), ringInput: { tick: 4294967200 + renders, type: 1, aux:0, speed:0 } };
      monitor.notifyInputListeners(e, renders > 0); layer.handleInput(e);
    }
    assert.equal(renders, 8); assert.equal(layer.log.count, 8); assert.equal(pops, 0);
    visible = false; monitor.notifyInputListeners(event('click')); assert.equal(renders, 8); visible = true;
    const image = layer.paint(ctx);
    assert.ok(image.texts.some(t => t.text.startsWith("R4294967")));
    assert.ok(image.texts.some(t => t.text.startsWith("*")));
    layer.menuItems()[2].onSelect(ctx);
    assert.ok(layer.paint(ctx).texts.some(t => t.text.startsWith("Phone receive time")));
    inBounds(image);
    // Framed: the title and the hint line sit at the padding; the log is between them.
    assert.deepEqual([at(image, 'Input events').x, at(image, 'Input events').y], [8, 8]);
    assert.equal(at(image, 'Unfiltered').y + font.lineHeight, 260 - 8);
    assert.ok(Math.max(...image.texts.map(t => t.x + t.width)) <= 576 - 8, 'nothing runs into the right padding');
    // Nothing bordering the window: the same lines run to its edges.
    viewport = unbordered(576, 260);
    const bare = layer.paint(ctx);
    inBounds(bare);
    assert.deepEqual([at(bare, 'Input events').x, at(bare, 'Input events').y], [0, 0]);
    assert.equal(at(bare, 'Unfiltered').y + font.lineHeight, 260);
    assert.ok(bare.texts.length >= image.texts.length, 'the log has no less room');
    viewport = bordered(576, 260);
    if (process.env.INPUT_EVENTS_PREVIEW) fs.writeFileSync(process.env.INPUT_EVENTS_PREVIEW, Buffer.concat([
      Buffer.from(`P5\n${image.width} ${image.height}\n255\n`), Buffer.from(image.withDrawsBaked().pixels),
    ]));
    layer.menuItems()[0].onSelect(ctx); monitor.notifyInputListeners(event('click'));
    assert.equal(layer.log.count, 8); assert.equal(layer.menuItems()[0].label, 'Resume capture');
    layer.menuItems()[1].onSelect(ctx); assert.equal(layer.log.count, 0);
    layer.menuItems()[0].onSelect(ctx); monitor.notifyInputListeners(event('ring-press'));
    assert.equal(layer.log.count, 1);
    layer.menuItems()[3].onSelect(ctx); monitor.notifyInputListeners(event('click'));
    assert.equal(removed, 1); assert.equal(layer.log.count, 1);
  } finally { layer.onRemoved(); }
});

const ring = (type, tick, received = 1000) => ({ ...event('click', received),
  ringInput: { type, tick, aux: 17, speed: 29 } });

test('filter matches stock timing boundaries, exemptions, wrap, reset and zero sentinel', () => {
  const f = new monitor.RingInputFilter();
  for (const [type, tick, accepted] of [
    [1,1000,true], [1,1099,false], [10,1099,true], [1,1100,true],
    [8,1101,true], [2,1200,false], [2,1201,true], [2,1201,false],
    [10,1201,true], [10,1202,true], [9,1301,true],
  ]) assert.equal(f.accept(ring(type, tick)), accepted, `${type}@${tick}`);
  f.reset(); assert.equal(f.accept(ring(1,1)), true);
  f.reset(); assert.equal(f.accept(ring(1,0xffffffd0)),true);
  assert.equal(f.accept(ring(1,0x33)),false); assert.equal(f.accept(ring(1,0x34)),true);
  // Backward timestamps / ring restart pass using unsigned subtraction.
  assert.equal(f.accept(ring(1,5)),true);
  f.reset(); assert.equal(f.accept(ring(1,0)),true); assert.equal(f.accept(ring(1,1)),true);
  assert.equal(f.accept(event('click')),true);
  assert.equal(f.accept({ ...event('click'), source: 'watch' }),true);
  // Host scheduling does not affect decisions; filtered events do not extend the window.
  f.reset(); assert.equal(f.accept(ring(4,1000,100000)),true);
  assert.equal(f.accept(ring(4,1050,999999)),false);
  assert.equal(f.accept(ring(4,1100,999999)),true);
  f.reset(); assert.equal(f.accept(ring(99,2000)),true);
  assert.equal(f.accept(ring(1,2050)),false);
});

test('raw debug observer sees suppressed reports once before app routing', async () => {
  monitor.resetRingInputFilter();
  const { exports: { Shell } } = shellDeclarations(), s = new Shell(), seen = [], routed = [];
  s.routeInput = async (e) => { routed.push(e); return { shell:false,window:true }; };
  s.syncInputFocus = () => {};
  const off = monitor.addInputListener((e, filtered) => seen.push([e, filtered]));
  try {
    const first = ring(1,1000), second = ring(1,1050);
    assert.equal(monitor.acceptInput(first),true); await s.receiveInput(first);
    assert.equal(monitor.acceptInput(second),false); await s.receiveInput(second);
    assert.equal(seen.length,2); assert.equal(routed.length,1);
    assert.deepEqual(seen.map((e) => e[1]),[false,true]);
    assert.equal(seen[1][0].ringInput.tick,1050);
    assert.equal(Object.isFrozen(seen[1][0].ringInput),true);
  } finally { off(); monitor.resetRingInputFilter(); }
});

test('raw-to-app conversion retains the unsigned ring clock and explicit scroll source', () => {
  const d = shellDeclarations();
  for (const [wire,eventType,direction] of [[4,1,'scroll-up'],[5,2,'scroll-down']]) {
    const raw = { kind:'sys-event', eventType, eventSource:2, ringInput: ring(wire,0xffffffff).ringInput };
    const input = d.exports.rawInputEventToInputEvent(raw);
    assert.equal(input.type,direction); assert.equal(input.source,'ring');
    assert.equal(input.timestampMs,12345678); assert.equal(input.ringInput.tick,0xffffffff);
    assert.notEqual(input.ringInput,raw.ringInput);
  }
});

test('debug history retains both clocks and uses unsigned gaps across counter wrap', () => {
  const log = new monitor.InputEventLog();
  log.add(ring(1,0xfffffff0,5000)); log.add(ring(1,0x10,5001),true);
  assert.equal(log.entries[0].gapMs,1); assert.equal(log.entries[0].ringGapTicks,32);
  assert.equal(log.entries[0].filtered,true);
  log.clear(); log.add(ring(1,500)); assert.equal(log.entries[0].ringGapTicks,null);
});

test('PressTracker pairs each gesture with the touch-down that began it', () => {
  const { PressTracker } = load('app/ui/gestures.ts');
  const t = new PressTracker();
  const ev = (type, source) => ({ type, source, timestampMs: 0 });
  assert.equal(t.followsPress(ev('ring-press', 'watch')), false);
  assert.equal(t.followsPress(ev('click', 'watch')), true);
  // Input with no touch-down of its own (finger-pinch tap, crown, older watch app) still acts.
  assert.equal(t.followsPress(ev('click', 'watch')), false);
  // A press pairs only with the next event, and only from its own source.
  t.followsPress(ev('ring-press', 'watch'));
  assert.equal(t.followsPress(ev('click', 'left-arm')), false);
  assert.equal(t.followsPress(ev('click', 'watch')), false);
  // Stock ring scroll notifications omit their source.
  t.followsPress(ev('ring-press', 'ring'));
  assert.equal(t.followsPress({ type: 'scroll-up', timestampMs: 0 }), true);
});
