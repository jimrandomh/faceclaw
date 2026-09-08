const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const js = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

// Run the worker's actual activity and lifecycle code with platform work stubbed.
function worker() {
  let now = 100_000, timer, renderCount = 0;
  const messages = [];
  const file = 'app/apps/terminal/terminal-app.worker.ts';
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const functions = new Set(['recencyKey', 'post', 'renderHubWindows', 'isSessionActive', 'isWindowSessionActive', 'hubAnimationShouldRun', 'syncWindowIconActivity', 'updateHubAnimation', 'noteSessionActivity', 'openWindow', 'closeWindow']);
  const variables = new Set(['windows', 'pendingViews', 'activeViewId', 'sessionRecency', 'sessionActivity', 'ACTIVITY_ACTIVE_MS', 'HUB_ANIMATION_STEP_MS', 'hubAnimationPhase', 'hubAnimationTimer', 'windowIconActivity', 'screenOn']);
  const selected = source.statements.filter(s =>
    ts.isFunctionDeclaration(s) && functions.has(s.name?.text) ||
    ts.isVariableStatement(s) && s.declarationList.declarations.some(d => variables.has(d.name.getText(source))) ||
    ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) && s.expression.left.getText(source) === 'global.onmessage');
  const context = {
    exports: {}, Date: { now: () => now },
    setInterval(fn, ms) { assert.equal(ms, 800); assert.equal(timer, undefined); timer = fn; return 1; },
    clearInterval() { timer = undefined; },
    global: { postMessage: message => messages.push(message) },
    scheduleRender() { renderCount++; }, renderAndSubmit() {}, maybeReconnectView() {},
    controlsInitialized: true, controls: new Map(), TERMINAL_TOOLS: [],
    getTerminalFontConfig: () => ({ cellWidth: 6, cellHeight: 12 }),
  };
  vm.runInNewContext(js(selected.map(s => s.getText(source)).join('\n')) + '\nexports.windows = windows;', context);
  const message = data => context.global.onmessage({ data });
  return {
    messages, windows: context.exports.windows,
    activity: (connection = 'host1', socket = 'a') => context.noteSessionActivity(connection, socket),
    openHub() { context.openWindow('hub', 'surface:hub', 'Terminal', { width: 576, height: 260 }); },
    addView(id, connectionId = 'host1', socket = 'a') {
      context.exports.windows.set(id, { windowId: id, kind: 'view', connectionId, socket, foreground: false, unsubscribers: [], client: { stop() {} } });
      context.updateHubAnimation();
    },
    close: id => context.closeWindow(id),
    screen: on => message({ type: 'screen', on }),
    advance(ms) { now += ms; timer?.(); },
    running: () => !!timer,
    phase(id) { return messages.filter(m => m.type === 'set-icon-activity' && m.windowId === id).at(-1)?.activity ?? 'idle'; },
  };
}

test('background hub aggregates activity; session icons match both host and socket', () => {
  const w = worker();
  w.openHub(); w.addView('a'); w.addView('b', 'host1', 'b'); w.addView('other-host', 'host2', 'a');
  assert.equal(w.running(), false);
  w.activity();
  assert.equal(w.phase('hub'), 'on'); assert.equal(w.phase('a'), 'on');
  assert.equal(w.phase('b'), 'idle'); assert.equal(w.phase('other-host'), 'idle');
  w.advance(800);
  assert.equal(w.phase('hub'), 'off'); assert.equal(w.phase('a'), 'off');
  w.advance(800); assert.equal(w.phase('a'), 'on');
  w.activity('host2', 'a'); assert.equal(w.phase('other-host'), 'on');
  w.advance(3400);
  assert.equal(w.phase('a'), 'idle'); assert.notEqual(w.phase('hub'), 'idle');
  w.advance(1600);
  assert.equal(w.phase('hub'), 'idle'); assert.equal(w.phase('other-host'), 'idle');
  assert.equal(w.running(), false);
});

test('animation continues with hub closed and stops after the final window closes', () => {
  const w = worker();
  w.openHub(); w.addView('a'); w.activity(); w.close('hub');
  w.advance(800); assert.equal(w.phase('a'), 'off'); assert.equal(w.running(), true);
  w.close('a'); assert.equal(w.running(), false);
  w.activity(); assert.equal(w.running(), false);
  w.openHub(); assert.equal(w.phase('hub'), 'on'); assert.equal(w.running(), true);
});

test('screen off pauses animation; wake recalculates fresh and expired activity', () => {
  const w = worker();
  w.addView('a'); w.activity(); w.screen(false);
  assert.equal(w.running(), false);
  w.advance(1000); w.screen(true);
  assert.equal(w.phase('a'), 'on'); assert.equal(w.running(), true);
  w.screen(false); w.advance(5000); w.screen(true);
  assert.equal(w.phase('a'), 'idle'); assert.equal(w.running(), false);
});

test('unopened sessions activate the hub and repeated pushes extend activity without duplicate messages', () => {
  const w = worker();
  w.openHub(); w.activity('host2', 'unopened');
  assert.equal(w.phase('hub'), 'on');
  const count = w.messages.length; w.activity('host2', 'unopened'); assert.equal(w.messages.length, count);
  w.advance(4000); w.activity('host2', 'unopened'); w.advance(2000);
  assert.notEqual(w.phase('hub'), 'idle');
  w.advance(3000); assert.equal(w.phase('hub'), 'idle');
});

function load(file, deps, globals = {}) {
  const context = { exports: {}, require(name) { assert.ok(name in deps, name); return deps[name]; }, ...globals };
  vm.runInNewContext(js(read(file)), context);
  return context.exports;
}

class Image {
  constructor(width, height) { this.width = width; this.height = height; this.pixels = new Uint8Array(width * height); }
}

test('cursor replaces only the prompt; marker and frame persist across cached blink phases', () => {
  const renders = [];
  const icons = load('app/graphics/icons.ts', { './image': { GrayImage: Image } }, {
    global: { isAndroid: true },
    com: { faceclaw: { app: { IconRenderer: { renderSvgGray(svg, size, stroke) {
      renders.push(svg); assert.equal(stroke, 2); return new Uint8Array(size * size).fill(255);
    } } } } },
  });
  for (const glyph of ['', '1', '3', 'A']) {
    const idle = icons.renderIconWithGlyph('terminal', glyph, 24, 'idle');
    const idleSvg = renders.at(-1);
    const on = icons.renderIconWithGlyph('terminal', glyph, 24, 'on');
    const onSvg = renders.at(-1);
    const off = icons.renderIconWithGlyph('terminal', glyph, 24, 'off');
    const offSvg = renders.at(-1);
    const prompt = '<path d="m7 11 2-2-2-2"/>';
    const cursor = '<rect x="7.5" y="8" width="1" height="6"/>';
    assert.ok(idleSvg.includes(prompt)); assert.ok(onSvg.includes(cursor));
    assert.equal(onSvg.includes(prompt), false); assert.equal(offSvg.includes(prompt), false);
    assert.equal(idleSvg.replace(prompt, ''), offSvg);
    assert.equal(onSvg.replace(cursor, ''), offSvg);
    assert.notEqual(on, off); assert.notEqual(idle, on);
    const count = renders.length;
    assert.equal(icons.renderIconWithGlyph('terminal', glyph, 24, 'on'), on);
    assert.equal(renders.length, count);
  }
  assert.equal(icons.renderIconWithGlyph('timer', '', 24, 'on'), icons.renderIcon('timer', 24));
});

test('host applies activity only to its own open windows and cleans up on close', async () => {
  let paints = 0;
  const worker = { postMessage() {} };
  const shellWindows = new Map();
  const { WorkerAppHost } = load('app/ui/shell/worker-window.ts', {
    '../../graphics/image': { GrayImage: Image },
    './chrome-layer': { windowIcon: (icon, letter, glyph, phase) => phase },
    '../../assistant/tool-registry': { toolRegistry: { removeAppTools() {} } },
    './geometry': { appViewportSize: () => ({ width: 576, height: 260 }) },
    '../../native/frame-timings': {},
    './shell': { shell: { registerWindow: w => shellWindows.set(w.windowId, w) } },
  });
  const host = new WorkerAppHost({ appId: 'terminal', worker, configureSurface: async () => {}, requestShellRender() { paints++; }, removeSurface() {} });
  const spec = { windowId: 'a', title: 'A', icon: 'terminal', iconGlyph: '1' };
  const window = host.openWindow(spec);
  await Promise.resolve();
  const send = (windowId, activity) => worker.onmessage({ data: { type: 'set-icon-activity', windowId, activity } });
  assert.equal(window.drawIcon(), 'idle');
  let count = paints; send('unknown', 'on'); assert.equal(paints, count);
  send('a', 'on'); assert.equal(window.drawIcon(), 'on'); assert.equal(paints, count + 1);
  count = paints; send('a', 'on'); assert.equal(paints, count);
  send('a', 'off'); assert.equal(window.drawIcon(), 'off');
  send('a', 'idle'); assert.equal(window.drawIcon(), 'idle');
  send('a', 'on'); window.close(); count = paints;
  send('a', 'off'); assert.equal(paints, count);
  const reopened = host.openWindow(spec); assert.equal(reopened.drawIcon(), 'idle');
});
