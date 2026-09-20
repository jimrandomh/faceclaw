const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const images = require('../.test-build/app/graphics/image.js');
const { SurfaceCompositor } = require('../.test-build/app/graphics/surface-compositor.js');
const protocol = require('../.test-build/app/g2/ble-protocol.js');
const events = require('../.test-build/app/g2/events.js');

function load(file, modules, globals = {}) {
  const context = { exports: {}, require: id => {
    if (!(id in modules)) throw new Error(`Unstubbed import: ${id}`);
    return modules[id];
  }, ...globals };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return context.exports;
}
const planes = load('app/graphics/plane.ts', { './image': images });
const timings = load('app/native/frame-timings.ts', {});

function fixture() {
  const observers = new Map(), phoneState = { protectedDataAvailable: true };
  let settingsChanged, remoteHost;
  let now = 1000, nextTask = 0, screenOn = true, shellOptions, session;
  const tasks = new Map(), sent = [], previews = [], received = [], errors = [];
  const boardStats = { starts: 0, stops: 0, paints: 0 };
  const settings = { lock: true, enabled: true, tap: true, hold: true, tilt: true, duration: 3000 };
  const clock = { Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => { tasks.set(++nextTask, { fn, at: now + ms }); return nextTask; },
    clearTimeout: id => tasks.delete(id), setInterval: () => ++nextTask, clearInterval() {} };
  const { GlanceHost } = load('app/g2/glance-host.ts', {
    '../graphics/image': images, '../graphics/plane': planes,
    '../graphics/glyph-wire': { prepareFrameDraws: () => null }, '../native/frame-timings': timings,
    '../ui/shell/geometry': { minWindowTop: () => 48 },
    '../util/render-freshness': { beginRenderPass() {}, endRenderPass: () => false },
    './glance-state': require('../.test-build/app/g2/glance-state.js'),
  }, clock);
  const window = { windowId: 'launcher', surfaceId: 'launcher', appId: 'launcher', title: 'Apps',
    requestRender() {}, setScreenOn() {} };
  const shell = {
    configure: options => { shellOptions = options; }, registerWindow() {}, focusWindow() {},
    wake: () => { screenOn = true; shellOptions.onScreenStateChanged(true); },
    sleep: () => { screenOn = false; shellOptions.onScreenStateChanged(false); },
    isScreenOn: () => screenOn, getWindows: () => [window], foregroundWindow: () => window,
    setBatteryLevels() {}, underlayDim: () => 1, getFocus: () => 'app', hasOverlay: () => false,
    describeInputTarget: () => 'test app',
    paintSurface: () => [{ image: new images.GrayImage(640, 480, 0), x: 0, y: 0 }],
    receiveInput: async input => {
      received.push(input);
      if (input.type === 'display-wake' || !screenOn && input.type === 'double-click') shell.wake();
    },
  };
  class Session {
    state = { phase: 'disconnected' };
    constructor(_transport, onState, onInput, _log, _activity, _compass, onWear) { session = this; this.onState = onState; this.onInput = onInput; this.onWear = onWear; }
    async enableWearDetectionAndRequestState() {}
    async start() { this.state = { phase: 'connected' }; this.onState(this.state); }
    async stop() { this.state = { phase: 'disconnected' }; this.onState(this.state); }
    async setBrightness() {}
    setFrame(pixels) { if (this.state.phase === 'connected') sent.push(pixels); }
    wake() {}
  }
  const provider = {
    isEnabled: () => settings.enabled, showOnTap: () => settings.tap,
    showOnLongPress: () => settings.hold, showOnHeadTilt: () => settings.tilt,
    tapTimeoutMs: () => settings.duration,
    createBoard: () => ({ start: () => boardStats.starts++, stop: () => boardStats.stops++,
      paint: () => { boardStats.paints++; return new images.GrayImage(100, 80, 200); } }),
  };
  const inputMonitor = load("app/ui/input-monitor.ts", {});
  const modules = {
    "../ui/input-monitor": inputMonitor,
    '../remote/service': { startRemoteInput(host) { remoteHost = host; } },
    '../assistant/system-tools': { registerSystemTools() {} },
    '../assistant/window-tools': { registerWindowTools() {} },
    '../assistant/navigate-tools': { registerNavigateTools() {} },
    '../assistant/roam-tools': { registerRoamTools() {} },
    "../native/ios-navigation-sensors": {},
    '../native/notification-icons.ios': { bindIosNotifications() {}, iosNotificationsChanged() {}, onIosNotificationPopup: () => () => {}, readActiveNotifications: () => [] },
    '../native/notification-sources': { shouldShowNotificationOnGlasses: () => true },
    "../native/compass.ios": { bindCompassSession() {}, receiveCompassEvent() {} },
    '@nativescript/core': { File: { fromPath: () => ({ writeTextSync() {} }) },
      knownFolders: { documents: () => ({ path: '/tmp' }) }, path },
    '../native/ios-bluetooth': { iosBluetooth: () => ({}) },
    '../native/ios-voice-input': { iosVoiceInput: { handleSessionEnded() {}, stopPhoneCapture() {} } },
    './glasses-session': { GlassesSession: Session },
    '../native/nightscout-bridge': { nightscoutBridge: { async start() {}, async stop() {} } },
    './glance-host': { GlanceHost }, './events': events,
    './lock-screen': { LOCK_SCREEN_SURFACE_ID: 'lock-screen', createLockScreenImage: () => new images.GrayImage(640, 480, 123) },
    './device-addresses': { loadDeviceAddresses: () => ({}) }, './ios-peripheral-identity': { deviceAddressError: () => null },
    '../apps/launcher': { launcherEntries: () => [] },
    '../apps/evenhub/installed-apps': {}, '../apps/evenhub/manager': {}, '../apps/evenhub/updates': {}, '../apps/evenhub': {},
    '../apps/launcher/launcher-app': { createLauncherWindow: () => window, LAUNCHER_SURFACE_ID: 'launcher' },
    '../apps/all-apps': { ALL_APPS: [{ appId: 'glanceboard', glanceboard: provider }] },
    '../phone-ui/onboarding-state': { isWelcomeSoundPending: () => false },
    '../ui/sound-effects': {},
    '../ui/shell/worker-window': {}, '../ui/shell/in-process-window': {},
    '../ui/dashboard-settings': { brightnessSetting: { get: () => 'auto' }, brightnessSettingToLevel: () => null, lockScreenEnabledSetting: { get: () => settings.lock }, onAnySettingChanged: fn => { settingsChanged = fn; return () => {}; }, previewColorSetting: { get: () => 'white' } },
    '../native/phone-battery': { readPhoneBatteryState: () => ({ battery: 80, charging: false }) },
    '../apps/ios-availability': { iosAppUnavailableReason: () => null },
    '../graphics/surface-compositor': { SurfaceCompositor }, '../graphics/plane': planes, '../graphics/image': images,
    '../native/ios-graphics': { previewPixels: pixels => pixels },
    '../ui/gestures': { makeInputEvent: event => event }, '../ui/layers': { noopLayerActions: {} },
    '../apps/files/text-viewer': {},
    '../ui/shell/shell': { shell, rawInputEventToInputEvent: event => ({
      ringInput: event.ringInput, timestampMs: now,
      type: event.kind === 'display-wake' ? 'display-wake'
        : ({ 0: 'click', 1: 'scroll-up', 2: 'scroll-down', 3: 'double-click', 9: 'long-press',
          10: 'long-press-release', 11: 'short-then-long-press' })[event.eventType] ?? 'unknown', source: 'ring',
    }) },
    '../ui/shell/geometry': { appViewportRect: () => ({ x: 0, y: 0, width: 640, height: 480 }) },
  };
  const { IosPreviewController } = load('app/g2/ios-preview-controller.ts', modules, {
    ...clock, console: { log() {}, warn() {}, error: text => errors.push(text) },
    UIDevice: { currentDevice: {} }, UIApplication: { sharedApplication: phoneState },
    UIApplicationProtectedDataWillBecomeUnavailable: 'lock', UIApplicationProtectedDataDidBecomeAvailable: 'unlock',
    UIDeviceBatteryLevelDidChangeNotification: 'level', UIDeviceBatteryStateDidChangeNotification: 'state',
    NSNotificationCenter: { defaultCenter: { addObserverForNameObjectQueueUsingBlock(name, _object, _queue, fn) { observers.set(name, fn); return name; }, removeObserver(name) { observers.delete(name); } } },
    NSOperationQueue: { mainQueue: {} },
  });
  const controller = new IosPreviewController((pixels, title) => previews.push({ pixels, title }), message => errors.push(message));
  controller.compositor.submitSurfaceFrame('launcher', new Uint8Array(640 * 480).fill(75), { x: 0, y: 0, width: 640, height: 480 });
  controller.resume();
  async function drain() { await controller.inputQueue; await controller.glance.queue; }
  async function advance(ms) {
    now += ms;
    for (const [id, task] of [...tasks]) if (task.at <= now && tasks.delete(id)) task.fn();
    await drain();
  }
  async function render() { await drain(); await advance(33); assert.deepEqual(errors, []); }
  async function hardware(type, source = 2, ringTick) {
    const payload = protocol.bytes(13, protocol.bytes(3, protocol.concat(protocol.integer(1, type), protocol.integer(2, source))));
    const input = protocol.decodeGlassesInput({ sid: protocol.SID.hub, flag: 1, payload });
    if (ringTick !== undefined) input.ringInput = { type: type === 3 ? 2 : 1, tick: ringTick, aux:0, speed:0 };
    session.onInput(input);
    await render();
  }
  async function phone(type, origin = 'ring') { controller.gesture(type, origin); await render(); }
  return { controller, shell, remoteHost, keyboardChanged: session => shellOptions.onKeyboardInputChanged(session), settings, phoneState, observers, wear: wearing => session.onWear(wearing), settingsChanged: () => settingsChanged(), sent, previews, received, boardStats, hardware, phone, advance, render };
}
const assertBlank = pixels => assert.ok(pixels.every(p => p === 0));
const assertBoard = pixels => {
  assert.equal(pixels[48 * 640 + 270], 200);
  assert.equal(pixels[0], 0, 'opaque Glanceboard hides the retained app and shell');
};

test('iOS sleep tap shows the shared board; repeated tap renews timeout and hides to black', async () => {
  const f = fixture(); await f.controller.connect(); f.shell.sleep(); await f.render();
  assertBlank(f.sent.at(-1));
  await f.hardware(0); assertBoard(f.sent.at(-1)); assert.equal(f.shell.isScreenOn(), false);
  assert.equal(f.previews.at(-1).title, 'Glanceboard'); assert.equal(f.received.length, 0);
  await f.advance(2000); await f.hardware(0); await f.advance(1100);
  assert.equal(f.controller.glance.isVisible(), true);
  const offset = f.sent.length;
  await f.advance(2000); await f.render();
  assert.equal(f.controller.glance.isVisible(), false);
  for (const pixels of f.sent.slice(offset)) assertBlank(pixels);
  assert.equal(f.boardStats.starts, 1); assert.equal(f.boardStats.stops, 1);
});

test('iOS holds and tap-then-holds last until release, including with phone backgrounded', async () => {
  const f = fixture(); await f.controller.connect(); f.shell.sleep(); f.controller.pause();
  const previews = f.previews.length;
  for (const type of [9, 11]) {
    await f.hardware(type, 1); assertBoard(f.sent.at(-1));
    await f.advance(10000); assert.equal(f.controller.glance.isVisible(), true);
    await f.hardware(10, 1); assertBlank(f.sent.at(-1));
  }
  assert.equal(f.previews.length, previews); assert.equal(f.received.length, 0);
});

test('double-tap and other shell wakes replace Glanceboard without waking it again', async () => {
  const f = fixture(); await f.controller.connect(); f.shell.sleep();
  await f.hardware(9); await f.hardware(3);
  assert.equal(f.shell.isScreenOn(), true); assert.equal(f.controller.glance.isVisible(), false);
  assert.equal(f.sent.at(-1)[0], 75); assert.equal(f.boardStats.stops, 1);
  f.shell.sleep(); await f.hardware(0); f.shell.wake(); await f.render();
  assert.equal(f.controller.glance.isVisible(), false); assert.equal(f.sent.at(-1)[0], 75);
  await f.advance(5000); await f.render(); assert.equal(f.sent.at(-1)[0], 75);
});

test('head tilt uses Glanceboard when enabled and otherwise wakes the regular UI', async () => {
  const f = fixture(); await f.controller.connect(); f.shell.sleep();
  await f.hardware(12, 1); assertBoard(f.sent.at(-1)); assert.equal(f.shell.isScreenOn(), false);
  await f.hardware(3); f.shell.sleep(); f.settings.tilt = false;
  await f.hardware(12, 1); assert.equal(f.shell.isScreenOn(), true); assert.equal(f.sent.at(-1)[0], 75);
});

test('disabled triggers and scrolls do not show the board; awake taps still reach the shell', async () => {
  const f = fixture(); await f.controller.connect();
  await f.hardware(0); assert.equal(f.received.at(-1).type, 'click'); assert.equal(f.boardStats.starts, 0);
  f.shell.sleep(); f.settings.tap = false; f.settings.hold = false;
  for (const type of [0, 9, 11, 10, 1, 2]) await f.hardware(type);
  assert.equal(f.boardStats.starts, 0); assertBlank(f.sent.at(-1));
  f.settings.enabled = false; f.settings.tap = f.settings.hold = true;
  for (const type of [0, 9, 11]) await f.hardware(type);
  assert.equal(f.boardStats.starts, 0);
  await f.hardware(3); assert.equal(f.shell.isScreenOn(), true);
});

test('phone preview gestures use Glanceboard; losing runtime cleans up holds and timers', async () => {
  const f = fixture(); f.shell.sleep();
  await f.phone('tap', 'mirror'); assertBoard(f.previews.at(-1).pixels);
  await f.phone('double-tap', 'mirror'); assert.equal(f.shell.isScreenOn(), true);
  f.shell.sleep(); await f.phone('long-press', 'ring');
  await f.phone('long-press-release', 'ring'); assertBlank(f.previews.at(-1).pixels);
  await f.phone('short-then-long-press', 'ring'); assert.equal(f.controller.glance.isVisible(), true);
  f.controller.pause(); await f.render(); assert.equal(f.controller.glance.isVisible(), false);
  f.controller.resume(); await f.render(); assertBlank(f.previews.at(-1).pixels);
  assert.equal(f.boardStats.starts, f.boardStats.stops);
});


test('iOS lock hides apps and Glanceboard, blocks input, and stays locked when put back on', async () => {
  const f = fixture(); await f.controller.connect(); f.shell.sleep(); await f.hardware(0);
  f.controller.pause();
  // The notification precedes the property change: do not immediately undo it.
  f.observers.get('lock')(); f.wear(false); await f.render();
  assert.equal(f.controller.glassesLocked, true);
  assert.equal(f.controller.glance.isVisible(), false);
  await f.hardware(3); // wake the lock screen
  assert.ok(f.sent.at(-1).every(p => p === 123));
  for (const type of [0, 1, 2, 9, 11]) await f.hardware(type);
  f.wear(true); await f.render();
  assert.equal(f.received.length, 0);
  assert.ok(f.sent.at(-1).every(p => p === 123));
  await f.hardware(3); assertBlank(f.sent.at(-1));
  await f.hardware(12, 1); assert.ok(f.sent.at(-1).every(p => p === 123));
  f.observers.get('unlock')(); await f.render();
  assert.equal(f.controller.glassesLocked, false);
  assert.equal(f.sent.at(-1)[0], 75);
  await f.hardware(0); assert.equal(f.received.length, 1);
});

test('iOS removal before phone lock, setting changes, and observer lifetime', async () => {
  const f = fixture(); await f.controller.connect(); f.wear(false); await f.render();
  assert.equal(f.controller.glassesLocked, false);
  f.observers.get('lock')(); await f.render();
  assert.equal(f.controller.glassesLocked, true);
  f.settings.lock = false; f.settingsChanged(); await f.render();
  assert.equal(f.controller.glassesLocked, false);
  f.settings.lock = true; f.settingsChanged(); await f.render();
  assert.equal(f.controller.glassesLocked, true);
  f.controller.pause(); assert.ok(f.observers.has('unlock'));
  await f.controller.disconnect(); assert.equal(f.observers.has('unlock'), false);
  f.controller.resume(); await f.render();
  assert.equal(f.controller.glassesLocked, false);
  assert.equal(f.observers.size, 4);
});

test('iOS wear notifications catch protected-data changes missed while suspended', async () => {
  const f = fixture(); await f.controller.connect(); f.controller.pause();
  f.phoneState.protectedDataAvailable = false; f.wear(false); await f.render();
  assert.equal(f.controller.glassesLocked, true);
  f.controller.resume(); await f.render();
  assert.equal(f.controller.glassesLocked, true);
  f.controller.pause(); f.phoneState.protectedDataAvailable = true;
  f.controller.resume(); await f.render();
  assert.equal(f.controller.glassesLocked, false);
});


test('iOS locked phone controls cannot dispatch mirror, voice, or keyboard input', async () => {
  const f = fixture(); await f.controller.connect(); f.wear(false);
  f.observers.get('lock')(); await f.render();
  await f.phone('tap', 'mirror'); await f.phone('long-press', 'watch');
  f.controller.startVoiceInput();
  assert.equal(await f.controller.prepareVoiceCapture(), false);
  await f.controller.startVoiceCapture(); await f.controller.typeIntoApp();
  assert.equal(f.received.length, 0);
  assert.equal(f.controller.glassesLocked, true);
  // Locked state also survives transport recovery until a phone unlock.
  f.controller.session.onState({ phase: 'retrying' });
  f.controller.session.onState({ phase: 'connecting' });
  f.controller.session.onState({ phase: 'connected' });
  await f.render();
  assert.ok(f.sent.at(-1).every(p => p === 123));
});


test('iOS deduplicates original ring ticks before apps, lock toggles and Glanceboard', async () => {
  const f = fixture(); await f.controller.connect();
  await f.hardware(0,2,1000); await f.hardware(0,2,1050);
  assert.equal(f.received.length,1);
  await f.hardware(0,2,1100); assert.equal(f.received.length,2);
  // A filtered click cannot open a sleep-time board.
  f.shell.sleep(); await f.hardware(0,2,1150);
  assert.equal(f.controller.glance.isVisible(),false);
  await f.hardware(0,2,1200); assert.equal(f.controller.glance.isVisible(),true);
  // A duplicated double tap must not wake and immediately re-sleep a lock screen.
  f.observers.get('lock')(); f.wear(false); await f.render();
  f.shell.sleep(); await f.hardware(3,2,2000);
  assert.equal(f.shell.isScreenOn(),true);
  await f.hardware(3,2,2050); assert.equal(f.shell.isScreenOn(),true);
  // A new transport session starts a fresh suppression window.
  f.controller.session.onState({ phase:'retrying' });
  f.controller.session.onState({ phase:'connected' });
  await f.hardware(3,2,2051); assert.equal(f.shell.isScreenOn(),false);
});

test('keyboard sessions cannot deliver text after the glasses lock or phone leaves the foreground', () => {
  const f = fixture();
  let editor;
  f.controller.onKeyboardInputChanged = session => { editor = session; };
  const calls = [];
  f.keyboardChanged({ targets: [{ id: 'app', label: 'Type into App' }],
    setText: text => calls.push(['text', text]), send: () => calls.push(['send']),
    sendTo: id => calls.push(['target', id]), discard: () => calls.push(['discard']) });
  editor.setText('hello'); editor.sendTo('app');
  assert.deepEqual(calls, [['text', 'hello'], ['target', 'app']]);
  f.controller.glassesLocked = true;
  editor.setText('locked'); editor.send(); editor.sendTo('app');
  assert.equal(calls.length, 2);
  f.controller.glassesLocked = false; f.controller.pause();
  editor.setText('background'); editor.sendTo('app');
  assert.equal(calls.length, 2);
  editor.discard(); assert.deepEqual(calls.at(-1), ['discard']);
});


test('external input shares iOS dispatch, including hold release and phone-lock gating', async () => {
  const f = fixture(); await f.controller.connect(); f.wear(false);
  assert.equal(f.remoteHost.ready(), true);
  assert.equal(f.remoteHost.locked(), false);
  await f.remoteHost.input('swipe-left', 'watch');
  await f.remoteHost.input('long-press', 'ring');
  assert.deepEqual(f.received.map(e => [e.type, e.source]), [
    ['swipe-left', 'watch'], ['long-press', 'ring'], ['long-press-release', 'ring'],
  ]);
  f.observers.get('lock')();
  assert.equal(f.remoteHost.locked(), true);
  await f.remoteHost.input('click', 'watch');
  assert.equal(f.received.length, 3);
});
