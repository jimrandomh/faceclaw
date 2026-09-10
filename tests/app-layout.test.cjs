const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const js = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function geometry() {
  const settings = Object.fromEntries(Object.entries({
    displayModeSetting: '576x288', verticalPositionSetting: 'middle',
    navigateDisplayModeSetting: 'global', navigateVerticalPositionSetting: 'global',
    terminalDisplayModeSetting: 'default', terminalVerticalPositionSetting: 'global',
  }).map(([name, value]) => [name, { value, get() { return this.value; } }]));
  const context = { exports: {}, require: (name) => {
    if (name === '../../graphics/image') return { G2_LENS_WIDTH: 640, G2_LENS_HEIGHT: 480 };
    assert.equal(name, '../dashboard-settings');
    return settings;
  } };
  vm.runInNewContext(js(read('app/ui/shell/geometry.ts')), context);
  const rect = (mode, appId) => ({ ...context.exports.appViewportRect(mode, appId) });
  return { ...context.exports, settings, rect };
}

test('defaults preserve normal windows, EvenHub height and tall terminal sessions', () => {
  const g = geometry();
  assert.deepEqual(g.rect('min', 'navigate'), { x: 64, y: 124, width: 576, height: 260 });
  assert.deepEqual(g.rect('min', 'terminal'), g.rect('min'));
  assert.deepEqual(g.rect('max', 'terminal'), { x: 64, y: 28, width: 576, height: 452 });
  assert.equal(g.windowBandHeight('medium', 'evenhub'), 316);
  g.settings.displayModeSetting.value = '640x480';
  assert.deepEqual(g.rect('max', 'terminal'), { x: 0, y: 28, width: 640, height: 452 });
});

test('Navigate can use a small bottom band while other apps fill the panel', () => {
  const g = geometry();
  g.settings.displayModeSetting.value = '640x480';
  g.settings.navigateDisplayModeSetting.value = '576x288';
  g.settings.navigateVerticalPositionSetting.value = 'bottom';
  assert.deepEqual(g.rect('min', 'navigate'), { x: 64, y: 220, width: 576, height: 260 });
  assert.equal(g.minWindowTop('navigate'), 192);
  assert.equal(g.sidebarStripVisible('window', 'navigate'), true);
  assert.equal(g.sidebarStripVisible('window', 'other'), false);
  assert.deepEqual(g.rect('min', 'other'), { x: 0, y: 28, width: 640, height: 452 });
});

test('Terminal can disable its tall default, inherit position or override both dimensions', () => {
  const g = geometry();
  g.settings.terminalDisplayModeSetting.value = 'global';
  assert.deepEqual(g.rect('max', 'terminal'), g.rect('min'));
  g.settings.verticalPositionSetting.value = 'top';
  assert.equal(g.windowTop('max', 'terminal'), 0);
  g.settings.terminalVerticalPositionSetting.value = 'lower';
  assert.equal(g.windowTop('max', 'terminal'), 144);
  g.settings.terminalDisplayModeSetting.value = '640x480';
  assert.deepEqual(g.rect('max', 'terminal'), { x: 0, y: 28, width: 640, height: 452 });
  assert.equal(g.sidebarStripVisible('window', 'terminal'), false);
  assert.equal(g.sidebarStripVisible('sidebar', 'terminal'), true);
  g.settings.terminalDisplayModeSetting.value = '576x480';
  assert.deepEqual(g.rect('max', 'terminal'), { x: 64, y: 28, width: 576, height: 452 });
});

test('all explicit size/position combinations stay within the display and align content below the bar', () => {
  const g = geometry();
  for (const globalMode of ['576x288', '576x480', '640x480']) {
    g.settings.displayModeSetting.value = globalMode;
    for (const appId of ['navigate', 'terminal']) {
      for (const mode of ['global', '576x288', '576x480', '640x480']) {
        g.settings[`${appId}DisplayModeSetting`].value = mode;
        for (const position of ['global', 'top', 'upper', 'middle', 'lower', 'bottom']) {
          g.settings[`${appId}VerticalPositionSetting`].value = position;
          const rect = g.rect('max', appId);
          assert.equal(rect.x + rect.width, 640);
          assert.equal(rect.y, g.windowTop('max', appId) + g.TOP_BAR_HEIGHT);
          assert.ok(rect.y >= 28 && rect.y + rect.height <= 480);
        }
      }
    }
  }
});

// Exercise the real worker message handler with platform work stubbed out.
function resizeHandler(file, globals) {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const handler = source.statements.find((s) => ts.isExpressionStatement(s)
    && ts.isBinaryExpression(s.expression) && s.expression.left.getText(source) === 'global.onmessage');
  assert.ok(handler);
  const context = { global: {}, ...globals };
  vm.runInNewContext(js(handler.getText(source)), context);
  return (viewport) => context.global.onmessage({ data: { type: 'resize-window', windowId: 'test', viewport } });
}

test('Navigate resize preserves its active route and window, and remeasures an open menu', () => {
  let paints = 0;
  let menuSize;
  const window = { windowId: 'test', viewportWidth: 640, viewportHeight: 452,
    menu: { resize: (size) => { menuSize = size; } }, lastSubmittedFingerprint: 'old' };
  const route = { destination: 'Home' };
  const resize = resizeHandler('app/apps/navigate/navigate-app.worker.ts', {
    window, route, render: () => { paints++; },
  });
  resize({ width: 576, height: 260 });
  assert.equal(window.viewportHeight, 260);
  assert.equal(window.viewportWidth, 576);
  assert.equal(window.lastSubmittedFingerprint, '');
  assert.equal(route.destination, 'Home');
  assert.deepEqual(menuSize, { width: 576, height: 260 });
  resize({ width: 576, height: 260 });
  assert.equal(paints, 1);
});

test('Terminal resize keeps the view identity, negotiates its grid and skips position-only changes', () => {
  const calls = [];
  const window = { kind: 'view', windowId: 'test', socket: 'session-1',
    viewportWidth: 576, viewportHeight: 452, cellWidth: 8, cellHeight: 16,
    menu: null, reconnectTimer: 42, emulator: { dispose: () => calls.push("dispose") },
    client: { stop: () => calls.push('stop'), setViewport: (...size) => calls.push(size) },
  };
  const resize = resizeHandler('app/apps/terminal/terminal-app.worker.ts', {
    windows: new Map([['test', window]]), clearTimeout: (timer) => calls.push(timer),
    TerminalEmulator: class { constructor(cols, rows) { this.cols = cols; this.rows = rows; } },
    reconnectView: (view) => { assert.equal(view, window); calls.push('reconnect'); },
    scheduleRender: () => calls.push('paint'),
  });
  resize({ width: 576, height: 260 });
  assert.equal(window.socket, 'session-1');
  assert.equal(window.gridCols, 72);
  assert.equal(window.gridRows, 16);
  assert.equal(window.emulator.rows, 16);
  assert.deepEqual(calls, [42, 'stop', [72, 16], 'dispose', 'reconnect', 'paint']);
  resize({ width: 576, height: 260 });
  assert.equal(calls.length, 6);
});

test('resizing a terminal reconnects with the new grid and ignores callbacks from the old socket', () => {
  const sockets = [];
  const context = {
    exports: {}, require: () => ({}),
    com: { faceclaw: { app: {
      FaceclawWebSocketListener: class { constructor(callbacks) { return callbacks; } },
      FaceclawWebSocket: class {
        constructor(url, listener) { this.listener = listener; this.messages = []; sockets.push(this); }
        sendText(text) { this.messages.push(JSON.parse(text)); }
        close() {}
      },
    } } },
  };
  vm.runInNewContext(js(read('app/native/g2mirror-client.ts')), context);
  const client = new context.exports.G2MirrorClient({ host: 'localhost', port: 1234, cols: 72, rows: 28 });
  client.start();
  const oldSocket = sockets[0];
  oldSocket.listener.onOpen();
  assert.equal(oldSocket.messages[0].height, 28);
  client.stop();
  client.setViewport(80, 16);
  client.start();
  const newSocket = sockets[1];
  oldSocket.listener.onClosed(1000, 'bye');
  oldSocket.listener.onFailure('late failure');
  oldSocket.listener.onTextMessage('{"type":"error","message":"late error"}');
  assert.equal(client.state().phase, 'connecting');
  newSocket.listener.onOpen();
  assert.equal(newSocket.messages[0].width, 80);
  assert.equal(newSocket.messages[0].height, 16);
  assert.equal(client.state().status, 'Authenticating...');
});
