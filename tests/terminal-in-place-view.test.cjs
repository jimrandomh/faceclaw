const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const HUB = 'terminal:hub';
const MIN = { width: 552, height: 260 };
const MAX = { width: 552, height: 452 };
const font = { lineHeight: 12, measureText: (text) => text.length * 6, getGlyph: () => null };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// A recording stand-in for the worker's images: enough to see what a frame shows.
function fakeImageModule() {
  class GrayImage {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.texts = [];
      return new Proxy(this, { get: (target, key) => (key in target ? target[key] : () => {}) });
    }
    drawText(_font, _x, _y, text) { this.texts.push(text); }
    drawMenuSelection(row) { this.texts.push(...row.texts.map((text) => `[${text}]`)); }
  }
  return { GrayImage };
}

// Runs the real worker against the shell's message protocol, stubbing only what
// sits behind it: the websocket client, the emulator, the display and the menu host.
function terminal({ sessions = ['vim', 'top'], presets = '', bellWake = true } = {}) {
  const replies = [], clients = [], frames = [], menus = [];
  const global = { postMessage: (message) => replies.push(message) };

  class FakeClient {
    constructor(options) {
      this.options = options;
      this.stopped = false;
      this.attached = null;
      this.sent = [];
      this.listeners = { state: [], bell: [], activity: [] };
      this.statusText = 'Connected.';
      clients.push(this);
    }
    state() { return { phase: this.stopped ? 'idle' : 'connected', status: this.statusText, serverName: 'host', sessions: sessions.map((title) => ({ socket: title, title, cwdHint: '' })) }; }
    start() { this.stopped = false; this.listeners.state.forEach((listener) => listener(this.state())); }
    stop() { this.stopped = true; }
    setViewport(cols, rows) { this.viewport = [cols, rows]; }
    connectSession(socket) { this.attached = socket; }
    sendInput(text) { this.sent.push(text); }
    submitInput(text) { this.sent.push(text); }
    listSessions() {}
    view() {}
    requestHistory() {}
    onStateChange(listener) { this.listeners.state.push(listener); return () => {}; }
    onBell(listener) { this.listeners.bell.push(listener); return () => {}; }
    onTitle() { return () => {}; }
    onActivity(listener) { this.listeners.activity.push(listener); return () => {}; }
    onSnapshot() { return () => {}; }
    onHistoryLines() { return () => {}; }
    onSessionAttached() { return () => {}; }
    onTerminalData() { return () => {}; }
    onSessionDetached() { return () => {}; }
  }

  class FakeEmulator {
    dispose() { this.disposed = true; }
    write() {}
    reset() {}
    bufferLength() { return 0; }
    lineAt() { return ''; }
    cursorRow() { return 0; }
    cursorCol() { return 0; }
  }

  // Click runs the first item, the way the real menu does at its initial selection.
  class FakeWindowMenu {
    constructor(options) { this.options = options; this.opened = null; menus.push(this); }
    isOpen() { return this.opened !== null; }
    open(items = this.options.items()) { this.opened = items; }
    close() { this.opened = null; }
    resize(size) { this.options.size = size; }
    paint() { this.options.items(); return [this.options.paintBase()]; }
    async handleInput(event) {
      if (event.type === 'click') {
        await this.opened[0].onSelect({ stack: { pop: () => { this.opened = null; }, push() {} } });
      }
    }
  }

  const setting = (value) => ({ id: 'setting', get: () => value, set() {} });
  const image = fakeImageModule();
  const load = loader({ global, setTimeout, clearTimeout, setInterval, clearInterval }, {
    '@nativescript/core/globals': {},
    './background': { hasTerminalBackgroundWork: () => false },
    '../../ui/shell/worker-lifecycle': { finishWorkerShutdown() {} },
    '../../graphics/image': image,
    '../graphics/image': image,
    '../../graphics/plane': {
      planesFingerprint: (planes) => JSON.stringify([planes[0].width, planes[0].height, planes[0].texts]),
      flattenPlanesWithDraws: (planes) => ({ image: { ...planes[0], width: planes[0].width, height: planes[0].height, texts: planes[0].texts, to8bppBuffer: () => ({ buffer: planes[0].texts }) }, draws: [] }),
    },
    '../../graphics/glyph-wire': { prepareFrameDraws: () => null },
    '../../graphics/ui-fonts': {
      getDefaultSmallFont: () => font,
      getTerminalFontConfig: () => ({ font, cellWidth: 6, cellHeight: 12 }),
    },
    '../../graphics/icons': { TERMINAL_ICON_GLYPHS: ['1', '2', '3'] },
    '../../native/frame-timings': {
      startFrame: () => 1, finishFrame() {}, logFrame() {},
      span: (_frame, _name, run) => run(), runWithFrame: (_frame, run) => run(),
    },
    '../../native/active-display': {
      getActiveDisplay: () => ({
        submitSurfaceFrame: (texts, surfaceId, _x, _y, width, height) => frames.push({ surfaceId, width, height, texts }),
      }),
    },
    '../../ui/gestures': { GESTURE_DOUBLE_CLICK: 'double-tap' },
    '../../native/g2mirror-client': { G2MirrorClient: FakeClient },
    '../../native/settings-store': { onSettingsStoreChanged() {} },
    '../../ui/dashboard-settings': {
      enumSettingMenuItem() {}, textSettingMenuItem() {}, toggleSettingMenuItem() {},
      terminalAutoReconnectSetting: setting(false),
      terminalDisplayLayoutSetting: setting('default'),
      terminalLaunchPresetsSetting: setting(presets),
      terminalNewConnectionSetting: setting(''),
      terminalWakeOnBellSetting: setting(bellWake),
    },
    '../../ui/font-picker': { terminalFontPickerMenuItem() {} },
    './connections': {
      TERMINAL_CONNECTIONS_KEY: 'terminal.connections',
      connectionDisplayName: (config) => config.id,
      loadConnections: () => [{ id: 'c1', url: 'ok', serverName: 'host', enabled: true }],
      parseConnectionString: () => ({ host: 'host' }),
      saveConnections() {}, updateConnection() {},
    },
    './terminal-emulator': { TerminalEmulator: FakeEmulator },
    '../../ui/menu': { drawSubmenuIndicator() {}, submenuItem: (label, onSelect) => ({ label, onSelect }) },
    '../../ui/window-menu': { WindowMenu: FakeWindowMenu, WindowMenuLayer: class {} },
    '../../ui/shell/geometry': { appViewportSize: () => MAX },
  });
  load('app/apps/terminal/terminal-app.worker.ts');

  const send = (message) => global.onmessage({ data: message });
  const input = (type, windowId = HUB) => send({ type: 'input', windowId, event: { type }, frameId: 0, focused: true });
  const openWindow = (windowId, viewport) => {
    send({ type: 'open-window', windowId, surfaceId: `window:${windowId}`, title: 'Terminal', viewport });
    send({ type: 'foreground', windowId, foreground: true, focused: true });
  };
  const repliesOf = (type) => replies.filter((reply) => reply.type === type);
  return {
    clients, frames, replies, menus, send, input, openWindow, repliesOf,
    lastFrame: () => frames[frames.length - 1],
    clearReplies: () => { replies.length = 0; },
    openMenu: (windowId = HUB) => input('short-then-long-press', windowId),
    menuLabels: () => Array.from(menus.find((menu) => menu.isOpen()).opened, (item) => item.label),
    closeMenu: () => menus.forEach((menu) => menu.close()),
    // Past Manage Connections and Settings to the first session row.
    selectFirstSession: () => { input('scroll-down'); input('scroll-down'); },
    answerHeight: (viewport, windowId = HUB) => send({ type: 'resize-window', windowId, viewport }),
  };
}

function hubShowingList() {
  const t = terminal();
  t.openWindow(HUB, MIN);
  t.selectFirstSession();
  return t;
}

function hubShowingSession() {
  const t = hubShowingList();
  t.input('click');
  t.answerHeight(MAX);
  t.clearReplies();
  return t;
}

test('selecting a session shows it in the same window, at the height the shell answers with', () => {
  const t = hubShowingList();
  assert.equal(t.clients.length, 1, 'just the control connection so far');
  assert.ok(t.lastFrame().texts.includes('[vim]') || t.lastFrame().texts.some((text) => text.includes('vim')));

  t.input('click');
  assert.deepEqual(t.repliesOf('open-window-request'), [], 'no new window');
  assert.deepEqual(t.repliesOf('set-height-mode').map((reply) => reply.heightMode), ['max']);
  assert.equal(t.clients.length, 1, 'no connection before the size is known');

  t.answerHeight(MAX);
  const view = t.clients[1];
  assert.deepEqual([view.options.cols, view.options.rows], [92, 37], 'grid from the answered viewport');
  assert.equal(view.attached, 'vim');
  assert.deepEqual([t.lastFrame().surfaceId, t.lastFrame().width, t.lastFrame().height], [`window:${HUB}`, MAX.width, MAX.height]);
  assert.ok(!t.lastFrame().texts.includes('Terminal'), 'the list is gone');
});

test('a repeated tap before the shell answers starts one view', () => {
  const t = hubShowingList();
  t.input('click');
  t.input('click');
  assert.equal(t.repliesOf('set-height-mode').length, 1);
  t.answerHeight(MAX);
  assert.equal(t.clients.length, 2);
});

test('text input reaches the session shown in place', () => {
  const t = hubShowingSession();
  t.send({ type: 'text-input', windowId: HUB, text: 'ls' });
  assert.deepEqual(t.clients[1].sent, ['ls']);
});

test('double-tap in a session shown in place goes back to the list, not the sidebar', () => {
  const t = hubShowingSession();
  t.input('double-click');
  assert.deepEqual(t.repliesOf('yield-focus'), []);
  assert.deepEqual(t.repliesOf('set-height-mode').map((reply) => reply.heightMode), ['min']);
  assert.equal(t.clients[1].stopped, false, 'the session stays up until the window has resized');

  t.answerHeight(MIN);
  assert.equal(t.clients[1].stopped, true);
  assert.deepEqual([t.lastFrame().width, t.lastFrame().height], [MIN.width, MIN.height]);
  assert.ok(t.lastFrame().texts.includes('Terminal'), 'the list is back');
  assert.ok(t.lastFrame().texts.includes('[vim]'), 'with the session just viewed still selected');

  t.input('double-click');
  assert.deepEqual(t.repliesOf('yield-focus').map((reply) => reply.windowId), [HUB], 'then double-tap yields as usual');
});

test('coming back from a session keeps the list order despite its bumped recency, until the list next becomes visible', () => {
  const t = hubShowingList();
  const sessionRows = () => t.lastFrame().texts.filter((text) => /vim|top/.test(text));
  t.input('scroll-down');
  assert.deepEqual(sessionRows(), ['vim', '[top]']);
  t.input('click');
  t.answerHeight(MAX);
  t.clients[0].listeners.activity.forEach((listener) => listener('top'));

  t.input('double-click');
  t.answerHeight(MIN);
  assert.deepEqual(sessionRows(), ['vim', '[top]']);

  t.send({ type: 'foreground', windowId: HUB, foreground: false, focused: false });
  t.send({ type: 'foreground', windowId: HUB, foreground: true, focused: true });
  assert.deepEqual(sessionRows().map((text) => text.replace(/[[\]]/g, '')), ['top', 'vim'], 're-sorted as usual');
});

test('the session just viewed stays selected when rows above it have shifted', () => {
  const sessions = ['vim', 'top', 'htop'];
  const t = terminal({ sessions });
  t.openWindow(HUB, MIN);
  t.selectFirstSession();
  t.input('scroll-down');
  t.input('click');
  t.answerHeight(MAX);
  // vim exits while top is on show, moving top's row up one (and htop into its place).
  sessions.shift();
  t.clients[0].listeners.state.forEach((listener) => listener(t.clients[0].state()));

  t.input('double-click');
  t.answerHeight(MIN);
  assert.ok(t.lastFrame().texts.includes('[top]'));
});

test('the window menu leads with Open in new window only while a session is selected', () => {
  const t = terminal();
  t.openWindow(HUB, MIN);
  t.openMenu();
  assert.equal(t.menuLabels()[0], 'Settings', 'Manage Connections is selected');
  t.closeMenu();
  t.input('scroll-down');
  t.openMenu();
  assert.equal(t.menuLabels()[0], 'Settings', 'Settings is selected');
  t.closeMenu();
  t.input('scroll-down');
  t.openMenu();
  assert.deepEqual(t.menuLabels().slice(0, 2), ['Open in new window', 'Settings']);
});

test('Open in new window on a selected session opens a window and leaves the list up', async () => {
  const t = hubShowingList();
  t.openMenu();
  t.input('click');
  await tick();
  assert.deepEqual(t.repliesOf('set-height-mode'), []);
  const [request] = t.repliesOf('open-window-request');
  assert.equal(request.title, 'vim');
  assert.equal(request.heightMode, 'max');
  assert.equal(request.focus, true);
  assert.equal(t.repliesOf('open-window-request').length, 1);
});

test('selecting a session already in its own window focuses that window', async () => {
  const t = hubShowingList();
  t.openMenu();
  t.input('click');
  await tick();
  const { windowId } = t.repliesOf('open-window-request')[0];
  t.send({ type: 'foreground', windowId: HUB, foreground: false, focused: false });
  t.openWindow(windowId, MAX);
  t.send({ type: 'foreground', windowId: HUB, foreground: true, focused: true });
  t.clearReplies();

  t.input('click');
  assert.deepEqual(t.repliesOf('focus-window').map((reply) => reply.windowId), [windowId]);
  assert.deepEqual(t.repliesOf('set-height-mode'), []);
});

test('a session in place can move to a new window: the list comes back first, then the window opens', async () => {
  const t = hubShowingSession();
  t.openMenu();
  assert.deepEqual(t.menuLabels().slice(0, 2), ['Open in new window', 'Settings']);
  t.input('click');
  await tick();
  assert.deepEqual(t.repliesOf('set-height-mode').map((reply) => reply.heightMode), ['min']);
  assert.deepEqual(t.repliesOf('open-window-request'), [], 'not while the old connection is up');

  t.answerHeight(MIN);
  assert.equal(t.clients[1].stopped, true);
  const [request] = t.repliesOf('open-window-request');
  assert.equal(request.title, 'vim');
  assert.equal(request.iconGlyph, '1');
  assert.ok(t.lastFrame().texts.includes('Terminal'));
});

test('a session in its own window keeps its plain menu and double-tap yields focus', async () => {
  const t = hubShowingList();
  t.openMenu();
  t.input('click');
  await tick();
  const { windowId } = t.repliesOf('open-window-request')[0];
  t.openWindow(windowId, MAX);
  t.openMenu(windowId);
  assert.equal(t.menuLabels()[0], 'Settings');
  t.closeMenu();
  t.input('double-click', windowId);
  assert.deepEqual(t.repliesOf('yield-focus').map((reply) => reply.windowId), [windowId]);
});

test('a bell still finds the window while the hub is showing a session', () => {
  const t = hubShowingSession();
  // A session with no view of its own wakes to the hub's window.
  t.clients[0].listeners.bell.forEach((listener) => listener('top', Date.now() + 1000));
  assert.deepEqual(t.repliesOf('wake-window').map((reply) => reply.windowId), [HUB]);
  t.clearReplies();

  // The session on show: flagged only while the window is in the background.
  t.send({ type: 'foreground', windowId: HUB, foreground: false, focused: false });
  t.clients[0].listeners.bell.forEach((listener) => listener('vim', Date.now() + 2000));
  assert.deepEqual(t.repliesOf('set-attention').map((reply) => reply.windowId), [HUB]);
});

test('a window backgrounded while waiting for the shell picks up the session without painting', () => {
  const t = hubShowingList();
  t.input('click');
  t.send({ type: 'foreground', windowId: HUB, foreground: false, focused: false });
  const painted = t.frames.length;
  t.answerHeight(MAX);
  assert.equal(t.frames.length, painted);
  t.send({ type: 'foreground', windowId: HUB, foreground: true, focused: true });
  assert.equal(t.lastFrame().height, MAX.height);
});

test('a list repaint scheduled before the swap does not paint over the session', async () => {
  const sessions = ['vim', 'top'];
  const t = terminal({ sessions });
  t.openWindow(HUB, MIN);
  t.selectFirstSession();
  t.input('click');
  // A new session makes the list's next paint differ, so it would be submitted.
  sessions.push('htop');
  t.clients[0].listeners.state.forEach((listener) => listener(t.clients[0].state()));
  t.answerHeight(MAX);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(t.lastFrame().height, MAX.height);
  assert.ok(!t.lastFrame().texts.includes('Terminal'));
});

test('a session repaint scheduled before the swap does not paint over the list', async () => {
  const t = hubShowingSession();
  t.input('double-click');
  t.clients[1].statusText = 'Reconnecting...';
  t.clients[1].listeners.state.forEach((listener) => listener(t.clients[1].state()));
  t.answerHeight(MIN);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(t.lastFrame().height, MIN.height);
  assert.ok(t.lastFrame().texts.includes('Terminal'));
});

test('closing the window while the shell has not answered drops the change', () => {
  const t = hubShowingList();
  t.input('click');
  t.send({ type: 'close-window', windowId: HUB });
  t.answerHeight(MAX);
  assert.equal(t.clients.length, 1, 'no view connection started');
});

test('closing the window while it shows a session stops that session', () => {
  const t = hubShowingSession();
  t.send({ type: 'close-window', windowId: HUB });
  assert.equal(t.clients[1].stopped, true);
});

test('a later resize of a session in place reconnects at the new grid, and the list then gets its own size', () => {
  const t = hubShowingSession();
  t.answerHeight({ width: 552, height: 400 });
  assert.equal(t.clients[1].stopped, false);
  assert.deepEqual(t.clients[1].viewport, [92, 33]);
  t.input('double-click');
  t.answerHeight({ width: 552, height: 240 });
  assert.equal(t.lastFrame().height, 240);
});

test('the shell host resizes the surface before answering with the new viewport', async () => {
  const worker = { posted: [], postMessage(message) { this.posted.push(message); } };
  const surfaces = [];
  const windows = [];
  let renders = 0;
  let foreground;
  const load = loader({ global: { isIOS: false }, setTimeout, clearTimeout, Promise }, {
    '../../graphics/image': {},
    './chrome-layer': { windowIcon() {} },
    '../../assistant/tool-registry': { toolRegistry: { removeAppTools() {} } },
    './geometry': { appViewportSize: (mode) => (mode === 'max' ? MAX : MIN) },
    '../../native/frame-timings': {},
    './worker-state': {},
    './shell': { shell: {
      registerWindow: (window) => windows.push(window),
      getWindows: () => windows,
      foregroundWindow: () => foreground,
      isWindowFocused: () => true,
    } },
  });
  const { WorkerAppHost } = load('app/ui/shell/worker-window.ts');
  let finishConfigure = () => {};
  const host = new WorkerAppHost({
    appId: 'terminal', worker,
    configureSurface: (surfaceId, visible, heightMode) => {
      surfaces.push({ surfaceId, visible, heightMode });
      return heightMode === 'min' ? Promise.resolve() : new Promise((resolve) => { finishConfigure = resolve; });
    },
    requestShellRender: () => { renders++; },
    removeSurface() {},
  });
  worker.onmessage({ data: { type: 'worker-ready' } });
  const window = host.openWindow({ windowId: HUB, title: 'Terminal', iconLetter: 'T' });
  foreground = window;
  await tick();
  worker.posted.length = 0;
  renders = 0;

  worker.onmessage({ data: { type: 'set-height-mode', windowId: HUB, heightMode: 'max' } });
  assert.equal(window.heightMode, 'max', 'the chrome reads the band from here');
  const configured = surfaces[surfaces.length - 1];
  assert.equal(configured.heightMode, 'max');
  assert.equal(configured.visible(), true, 'asked late: the window may have lost the foreground');
  foreground = undefined;
  assert.equal(configured.visible(), false);
  foreground = window;
  await tick();
  assert.deepEqual(worker.posted, [], 'no answer before the surface is ready');

  finishConfigure();
  await tick();
  assert.deepEqual(worker.posted.map((message) => [message.type, message.viewport]), [['resize-window', MAX]]);
  assert.equal(renders, 1);

  // Any later relayout (a switcher height change) keeps the new band.
  worker.posted.length = 0;
  window.relayout();
  assert.deepEqual(worker.posted.map((message) => message.viewport), [MAX]);

  // Unchanged band: still answered, so the worker can always wait on it.
  worker.posted.length = 0;
  worker.onmessage({ data: { type: 'set-height-mode', windowId: HUB, heightMode: 'min' } });
  await tick();
  worker.onmessage({ data: { type: 'set-height-mode', windowId: HUB, heightMode: 'min' } });
  await tick();
  assert.deepEqual(worker.posted.map((message) => message.viewport), [MIN, MIN]);

  // A closed window is not touched again.
  window.close();
  const count = surfaces.length;
  worker.onmessage({ data: { type: 'set-height-mode', windowId: HUB, heightMode: 'max' } });
  await tick();
  assert.equal(surfaces.length, count);
});
