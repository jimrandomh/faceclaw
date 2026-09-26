const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const sent = [], stopped = [], removed = [], focused = [], timers = new Map(), published = [];
  let kills = 0, resolveSurface;
  const worker = { postMessage: message => sent.push(message), terminate: () => kills++ };
  const shellWindows = new Map();
  const load = loader({ global: {}, setTimeout: (fn, ms) => { timers.set(fn, ms); return fn; }, clearTimeout: fn => timers.delete(fn) }, {
    '../../graphics/image': {}, './chrome-layer': { windowIcon() {} },
    '../../assistant/tool-registry': { toolRegistry: { removeAppTools() {} } },
    './geometry': { appViewportSize: () => ({ width: 576, height: 288 }) },
    '../../native/frame-timings': {}, './worker-state': { publishWorkerState: (...args) => published.push(args) },
    './shell': { shell: { registerWindow: w => shellWindows.set(w.windowId, w), setTrayIcon() {},
      focusWindow: id => focused.push(id), isWindowFocused: () => false } },
  });
  const { WorkerAppHost } = load('app/ui/shell/worker-window.ts');
  const host = new WorkerAppHost({ appId: 'game', worker, onStopping: () => stopped.push(host),
    configureSurface: () => new Promise(resolve => { resolveSurface = resolve; }),
    setSurfaceVisible() {}, removeSurface: id => removed.push(id), requestShellRender() {} });
  return { host, sent, stopped, timers, removed, focused, published, get kills() { return kills; },
    ready: () => worker.onmessage({ data: { type: 'worker-ready' } }),
    reply: data => worker.onmessage({ data }),
    open: id => host.openWindow({ windowId: id, title: id, focus: true }),
    surfaceReady: () => resolveSurface(),
  };
}

test('last window drains close cleanup, then exits the worker and releases its cached host', () => {
  const f = fixture(); f.ready(); const a = f.open('a'), b = f.open('b');
  a.close(); assert.equal(f.sent.some(m => m.type === 'check-idle'), false);
  b.close(); assert.deepEqual(f.sent.slice(-2).map(m => m.type), ['close-window', 'check-idle']);
  f.reply({ type: 'publish-state', key: 'test', state: 1 });
  f.reply({ type: 'worker-idle' });
  assert.equal(f.stopped.length, 1); assert.equal(f.kills, 0);
  assert.equal(f.sent.at(-1).type, 'shutdown');
  assert.deepEqual(f.published.at(-1), ['test', undefined]);
  f.reply({ type: 'open-window-request', windowId: 'late', title: 'late' });
  assert.equal(f.host.windowCount(), 0);
  f.reply({ type: 'worker-stopped' }); f.reply({ type: 'worker-stopped' });
  assert.equal(f.kills, 1); assert.equal(f.timers.size, 0);
  assert.throws(() => f.open('reopen'), /shutting down/);
});

test('closing before worker-ready still delivers open/close/idle in order', async () => {
  const f = fixture(); f.open('loading').close(); assert.equal(f.sent.length, 0);
  f.ready(); assert.deepEqual(f.sent.map(m => m.type), ['open-window', 'close-window', 'check-idle']);
  f.surfaceReady(); await flush(); assert.deepEqual(f.focused, []);
  f.reply({ type: 'worker-idle' }); f.reply({ type: 'worker-stopped' }); assert.equal(f.kills, 1);
});

test('a late idle report cannot kill a reopened window, and background ownership can end later', () => {
  const f = fixture(); f.ready(); f.open('first').close();
  // A background worker does not report idle while it still owns connections.
  assert.equal(f.stopped.length, 0);
  const reopened = f.open('second'); f.reply({ type: 'worker-idle' });
  assert.equal(f.stopped.length, 0);
  reopened.close(); f.reply({ type: 'worker-idle' });
  assert.equal(f.stopped.length, 1);
  for (const timeout of [...f.timers.keys()]) timeout();
  assert.equal(f.kills, 1, 'a hung shutdown cannot leave the thread alive');
});

test('Terminal stays alive only for a configured visible-layout widget and an enabled valid connection', () => {
  const settings = new Map();
  const load = loader({}, { '../../native/settings-store': {
    getStringSetting: (key, fallback) => settings.get(key) ?? fallback,
  } });
  const { hasTerminalBackgroundWork } = load('app/apps/terminal/background.ts');
  settings.set('terminal.connections', JSON.stringify([{ id: 'test', url: 'g2mirror://token@localhost', enabled: true }]));
  assert.equal(hasTerminalBackgroundWork(), false);
  settings.set('glanceboard.quadrants.slot.1', 'terminal'); assert.equal(hasTerminalBackgroundWork(), true);
  settings.set('glanceboard.enabled', false); assert.equal(hasTerminalBackgroundWork(), true, 'configured cards also appear in the Glanceboard app');
  settings.delete('glanceboard.quadrants.slot.1'); settings.set('glanceboard.quadrants.slot.5', 'terminal');
  assert.equal(hasTerminalBackgroundWork(), false);
  settings.set('glanceboard.layout', '2x3'); assert.equal(hasTerminalBackgroundWork(), true);
  for (const connections of [[], [{ id: 'test', url: 'invalid' }], [{ id: 'test', url: 'g2mirror://token@localhost', enabled: false }]]) {
    settings.set('terminal.connections', JSON.stringify(connections)); assert.equal(hasTerminalBackgroundWork(), false);
  }
});

test('worker shutdown unregisters the isolate settings observer before acknowledging', () => {
  const calls = [];
  const { finishWorkerShutdown } = loader({ global: { postMessage: message => calls.push(message.type) } }, {
    '../../native/settings-store': { disposeSettingsStore: () => calls.push('dispose') },
  })('app/ui/shell/worker-lifecycle.ts');
  finishWorkerShutdown(); assert.deepEqual(calls, ['dispose', 'worker-stopped']);
});

test('every app worker answers idle checks and shutdown; Terminal releases controls only on shutdown', () => {
  const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
  for (const app of ['blocks', 'flappy', 'freecell', 'minesweeper', 'navigate', 'pinball', 'roam', 'terminal']) {
    const path = `app/apps/${app}/${app}-app.worker.ts`;
    const source = ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const statements = source.statements.filter(s =>
      ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) && s.expression.left.getText(source) === 'global.onmessage' ||
      app === 'terminal' && ts.isFunctionDeclaration(s) && s.name?.text === 'reportIdle' ||
      app === 'terminal' && ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && s.expression.expression.getText(source) === 'onSettingsStoreChanged');
    const messages = [], cleanup = []; let background = true, changed;
    const context = { global: {}, windows: new Map(), controls: new Map([['one', 1], ['two', 2]]),
      post: message => messages.push(message.type), hasTerminalBackgroundWork: () => background,
      finishWorkerShutdown: () => cleanup.push('shutdown'), stopControl: value => cleanup.push(value),
      onSettingsStoreChanged: callback => { changed = callback; },
    };
    vm.runInNewContext(ts.transpileModule(statements.map(s => s.getText(source)).join('\n'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText, context);
    context.global.onmessage({ data: { type: 'check-idle' } });
    if (app === 'terminal') {
      assert.deepEqual(messages, []); assert.equal(context.controls.size, 2);
      background = false; changed('glanceboard.quadrants.slot.1');
    }
    assert.deepEqual(messages, ['worker-idle'], app);
    assert.deepEqual(cleanup, [], 'idle reports must not tear down a concurrently reopened app');
    context.global.onmessage({ data: { type: 'shutdown' } });
    assert.deepEqual(cleanup, app === 'terminal' ? [1, 2, 'shutdown'] : ['shutdown']);
    if (app === 'terminal') assert.equal(context.controls.size, 0);
  }
});

test('both controllers remove only the retiring host and create a fresh worker on relaunch', () => {
  const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
  for (const platform of ['dashboard', 'ios-preview']) {
    const path = `app/g2/${platform}-controller.ts`;
    const source = ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const controller = source.statements.find(s => ts.isClassDeclaration(s) && s.name.text.endsWith('Controller'));
    const method = controller.members.find(s => s.name?.getText(source) === 'ensureWorkerHost');
    const context = { exports: {}, WorkerAppHost: class { constructor(options) { this.options = options; } } };
    vm.runInNewContext(ts.transpileModule(`export class Controller { ${method.getText(source)} }`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText, context);
    const host = new context.exports.Controller(); host.appHosts = new Map();
    const first = host.ensureWorkerHost('flappy', () => ({}));
    assert.equal(host.ensureWorkerHost('flappy', assert.fail), first);
    first.options.onStopping(); assert.equal(host.appHosts.size, 0);
    const next = host.ensureWorkerHost('flappy', () => ({})); assert.notEqual(next, first);
    first.options.onStopping(); assert.equal(host.appHosts.get('flappy'), next);
  }
});
