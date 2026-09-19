const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
function load(file, context) {
  const sandbox = { exports: {}, ...context };
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, sandbox);
  return sandbox.exports;
}
test('iOS phone battery distinguishes unknown, charging, full and unplugged readings', () => {
  const device = { batteryLevel: -1, batteryState: 0 };
  const api = load('app/native/phone-battery.ts', { require: () => ({}), global: { isIOS: true },
    UIDevice: { currentDevice: device }, UIDeviceBatteryState: { Unknown: 0, Unplugged: 1, Charging: 2, Full: 3 } });
  assert.deepEqual({ ...api.readPhoneBatteryState() }, { battery: null, charging: null });
  device.batteryLevel = 0.726; device.batteryState = 2;
  assert.deepEqual({ ...api.readPhoneBatteryState() }, { battery: 73, charging: true });
  device.batteryLevel = 1; device.batteryState = 3;
  assert.deepEqual({ ...api.readPhoneBatteryState() }, { battery: 100, charging: true });
  device.batteryLevel = 0; device.batteryState = 1;
  assert.deepEqual({ ...api.readPhoneBatteryState() }, { battery: 0, charging: false });
});
test('settings changes propagate between iOS worker isolates once, including after a getter read', () => {
  const store = new Map(), ticks = new Set(), tasks = [];
  const ApplicationSettings = { getString: (k, d) => store.get(k) ?? d, getBoolean: (k, d) => store.get(k) ?? d,
    setString: (k, v) => store.set(k, v), setBoolean: (k, v) => store.set(k, v), hasKey: k => store.has(k) };
  const context = { require: () => ({ ApplicationSettings }), setTimeout: fn => tasks.push(fn),
    setInterval: fn => { ticks.add(fn); return fn; }, clearInterval: fn => ticks.delete(fn) };
  const main = load('app/native/settings-store.ios.ts', context), worker = load('app/native/settings-store.ios.ts', context);
  const seenMain = [], seenWorker = [];
  const offMain = main.onSettingsStoreChanged(k => seenMain.push(k));
  const offWorker = worker.onSettingsStoreChanged(k => seenWorker.push(k));
  main.getStringSetting('terminal.connections', '[]'); worker.getStringSetting('terminal.connections', '[]');
  main.setStringSetting('terminal.connections', '["test"]');
  assert.equal(worker.getStringSetting('terminal.connections', '[]'), '["test"]');
  const flush = () => { for (const tick of ticks) tick(); while (tasks.length) tasks.shift()(); };
  flush(); flush();
  assert.deepEqual(seenMain, ['terminal.connections']); assert.deepEqual(seenWorker, ['terminal.connections']);
  main.getBooleanSetting('sound', true); worker.getBooleanSetting('sound', true);
  worker.setBooleanSetting('sound', false); flush();
  assert.equal(main.getBooleanSetting('sound', true), false);
  assert.deepEqual(seenMain, ['terminal.connections', 'sound']);
  offWorker(); offMain(); assert.equal(ticks.size, 0);
});
test('iOS worker frames preserve baked grayscale bytes through the message boundary', () => {
  const messages = [];
  const api = load('app/native/active-display.ios.ts', { global: { postMessage: m => messages.push(m) },
    interop: { handleof: b => b }, NSData: { dataWithBytesLength: (b, n) => ({ base64EncodedStringWithOptions: () => Buffer.from(b, 0, n).toString('base64') }) } });
  const pixels = new Uint8Array([0, 1, 15, 127, 254, 255]);
  api.getActiveDisplay().submitSurfaceFrame(pixels.buffer, 'window:blocks:main', 0, 0, 3, 2);
  assert.equal(messages[0].surfaceId, 'window:blocks:main');
  assert.equal(messages[0].width, 3); assert.equal(messages[0].height, 2);
  assert.deepEqual(Buffer.from(messages[0].pixels, 'base64'), Buffer.from(pixels));
});

test('settings-driven repaint runs after font cache invalidation, regardless of subscription order', () => {
  const listeners = [], tasks = [], painted = [];
  let cachedFont = 'Light';
  const api = load('app/ui/dashboard-settings.ts', {
    require: id => id.includes('settings-store') ? { onSettingsStoreChanged: fn => listeners.push(fn) }
      : { Layer: class {}, ASSISTANT_MODEL_VALUES: [] },
    setTimeout: fn => tasks.push(fn),
  });
  api.onAnySettingChanged(() => painted.push(cachedFont));
  listeners.push(() => { cachedFont = 'Bold'; });
  for (const listener of listeners) listener('display.uiFont2');
  while (tasks.length) tasks.shift()();
  assert.deepEqual(painted, ['Bold']);
});

test('background glasses input still composites frames; phone resume preserves the session; explicit stop stays stopped', async () => {
  const tasks = new Map(), screenStates = [], inputs = [], frames = [], previews = [], states = [];
  let nextTask = 0, starts = 0, stops = 0, pollStarts = 0, pollStops = 0, session;
  const window = { windowId: 'launcher', surfaceId: 'launcher', appId: 'launcher', title: 'Apps',
    setScreenOn: on => screenStates.push(on), requestRender() {} };
  const shell = { configure() {}, registerWindow() {}, wake() {}, focusWindow() {},
    getWindows: () => [window], foregroundWindow: () => window, isScreenOn: () => true,
    setBatteryLevels() {}, paintSurface() {}, underlayDim: () => 0, getFocus: () => 'app',
    receiveInput: async input => { inputs.push(input); } };
  class Session {
    state = { phase: 'disconnected' };
    constructor(_transport, onState, onInput) { session = this; this.onState = onState; this.onInput = onInput; }
    async start() { starts++; this.state = { phase: 'connected' }; this.onState(this.state); }
    async stop() { stops++; this.state = { phase: 'disconnected' }; this.onState(this.state); }
    setFrame(pixels) { if (this.state.phase === 'connected') frames.push(pixels); }
    wake() {}
  }
  const settings = { onAnySettingChanged: () => () => {}, previewColorSetting: { get: () => 'white' } };
  const modules = {
    '@nativescript/core': { File: { fromPath: () => ({ writeTextSync() {} }) }, knownFolders: { documents: () => ({ path: '/tmp' }) }, path },
    '../native/ios-voice-input': { iosVoiceInput: { handleSessionEnded() {} } },
    '../native/ios-bluetooth': { iosBluetooth: () => ({}) }, './glasses-session': { GlassesSession: Session },
    '../native/nightscout-bridge': { nightscoutBridge: { async start() { pollStarts++; }, async stop() { pollStops++; } } },
    './glance-host': { GlanceHost: class { dismiss() {} isVisible() { return false; } } },
    './device-addresses': { loadDeviceAddresses: () => ({}) }, './ios-peripheral-identity': { deviceAddressError: () => null },
    '../apps/launcher/launcher-app': { createLauncherWindow: () => window, LAUNCHER_SURFACE_ID: 'launcher' },
    '../apps/all-apps': { ALL_APPS: [] }, '../ui/dashboard-settings': settings,
    '../native/phone-battery': { readPhoneBatteryState: () => ({ battery: 80, charging: false }) },
    '../graphics/surface-compositor': { SurfaceCompositor: class {
      configureSurface() {} setSurfaceVisible() {} submitSurfaceFrame() {} setUnderlayDim() {} setScreenBlanked() {}
      composite() { return new Uint8Array([1, 2]); }
    } },
    '../graphics/plane': { flattenPlanes: () => ({ pixels: new Uint8Array([1, 2]), width: 2, height: 1 }) },
    '../native/ios-graphics': { previewPixels: pixels => pixels },
    '../ui/shell/shell': { shell, rawInputEventToInputEvent: input => input },
    '../ui/shell/geometry': { appViewportRect: () => ({ x: 0, y: 0, width: 640, height: 480 }) },
    pako: { deflate: x => x },
  };
  const api = load('app/g2/ios-preview-controller.ts', {
    require: id => modules[id] ?? {}, console: { log() {}, warn() {}, error() {} },
    setTimeout: fn => { tasks.set(++nextTask, fn); return nextTask; }, clearTimeout: id => tasks.delete(id),
    setInterval: () => ++nextTask, clearInterval() {},
    UIDevice: { currentDevice: {} }, UIApplication: { sharedApplication: { protectedDataAvailable: true } },
    UIDeviceBatteryLevelDidChangeNotification: 'level', UIDeviceBatteryStateDidChangeNotification: 'state',
    NSNotificationCenter: { defaultCenter: { addObserverForNameObjectQueueUsingBlock() {}, removeObserver() {} } },
    NSOperationQueue: { mainQueue: {} },
  });
  const flush = () => { for (const [id, fn] of [...tasks]) { if (tasks.delete(id)) fn(); } };
  const controller = new api.IosPreviewController(image => previews.push(image), assert.fail, state => states.push(state));
  controller.resume(); await controller.connect(); flush();
  const previewCount = previews.length, stateCount = states.length;
  controller.pause(); controller.pause(); // NativeScript also unloads its root page on background entry.
  assert.equal(stops, 0); assert.ok(screenStates.every(Boolean));
  assert.equal(pollStarts, 1); assert.equal(pollStops, 0, 'connected glasses keep Nightscout polling in background');
  session.onInput({ eventType: 3, eventSource: 1 });
  await controller.inputQueue; flush();
  assert.equal(inputs.length, 1); assert.ok(frames.length >= 2);
  assert.equal(previews.length, previewCount); assert.equal(states.length, stateCount);
  controller.resume(); flush();
  assert.equal(starts, 1); assert.ok(previews.length > previewCount);
  controller.pause(); await controller.disconnect(); flush();
  assert.equal(stops, 1); assert.equal(screenStates.at(-1), false);
  assert.equal(pollStops, 1);
  const frameCount = frames.length;
  session.onInput({ eventType: 3, eventSource: 1 }); await controller.inputQueue; flush();
  assert.equal(inputs.length, 1); assert.equal(frames.length, frameCount);
  controller.resume(); flush();
  assert.equal(starts, 1); assert.equal(controller.connectionState.phase, 'disconnected');
  assert.equal(pollStarts, 2, 'resuming the phone restarts Nightscout polling');
});

test('iOS bandwidth footer toggles live, polls only in foreground and resets its rate window on resume', () => {
  const views = [], intervals = new Map(), appEvents = new Map(), settingListeners = new Set();
  let enabled = false, atMs = 0, totals = { messages: 0, bytes: 0, frames: 0 }, nextId = 0;
  class View {
    events = new Map(); children = [];
    constructor() { views.push(this); }
    on(event, fn) { this.events.set(event, fn); }
    addChild(view) { this.children.push(view); }
    getActualSize() { return { width: 0, height: 0 }; }
    static setRow() {} static setColumn() {}
  }
  const core = { Application: { suspendEvent: 'suspend', resumeEvent: 'resume',
    on: (key, fn) => appEvents.set(key, fn), off: key => appEvents.delete(key) },
    Button: View, Color: class {}, Dialogs: {}, GridLayout: View, Image: View, Label: View, Page: View, StackLayout: View };
  const modules = {
    '@nativescript/core': core,
    '../apps/all-apps': { ALL_APPS: [] },
    '../g2/ios-preview-controller': { IosPreviewController: class { resume() {} pause() {} } },
    './phone-gestures': { PhoneGestureRecognizer: class { cancel() {} } },
    './ble-bandwidth-meter': require('../.test-build/app/phone-ui/ble-bandwidth-meter.js'),
    '../native/ble-traffic': { sampleBleTraffic: () => totals },
    '../ui/dashboard-settings': { showBleBandwidthSetting: { get: () => enabled },
      onAnySettingChanged: fn => { settingListeners.add(fn); return () => settingListeners.delete(fn); } },
    '../g2/device-addresses': { loadDeviceAddresses: () => ({}) },
    '../g2/ios-peripheral-identity': { deviceAddressError: () => 'no test devices' },
  };
  const { createMainPage } = load('app/phone-ui/main-page.ios.ts', {
    require: id => modules[id] ?? {}, Date: { now: () => atMs },
    setInterval: fn => { const id = ++nextId; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id),
    setTimeout: () => 1, clearTimeout() {},
  });
  const page = createMainPage(), footer = views.find(v => v.accessibilityIdentifier === 'ble-bandwidth-indicator');
  page.events.get('loaded')(); assert.equal(intervals.size, 0); assert.equal(footer.visibility, 'collapse');
  enabled = true; for (const fn of settingListeners) fn();
  assert.equal(intervals.size, 1); assert.equal(footer.visibility, 'visible');
  totals = { messages: 4, bytes: 2000, frames: 2 }; atMs = 1000; for (const fn of intervals.values()) fn();
  assert.match(footer.text, /2.0 fps, 1,000 B\/frame/);
  appEvents.get('suspend')(); assert.equal(intervals.size, 0);
  const previousText = footer.text;
  totals = { messages: 40, bytes: 20000, frames: 20 }; atMs = 20000;
  for (const fn of settingListeners) fn(); assert.equal(footer.text, previousText); assert.equal(intervals.size, 0);
  appEvents.get('resume')(); assert.equal(intervals.size, 1); assert.doesNotMatch(footer.text, /fps/);
  enabled = false; for (const fn of settingListeners) fn(); assert.equal(footer.visibility, 'collapse'); assert.equal(intervals.size, 0);
  page.events.get('unloaded')(); assert.equal(appEvents.size, 0); assert.equal(settingListeners.size, 0);
});

test('iOS configures an in-process surface before submitting constructor-triggered frames', async () => {
  const submitted = [], surfaces = new Set();
  const shell = { getWindows: () => [], configure() {}, registerWindow() {}, focusWindow() {}, foregroundWindow: () => null };
  const api = load('app/g2/ios-preview-controller.ts', {
    require: name => ({
      '../ui/shell/shell': { shell },
      '../ui/shell/geometry': { appViewportRect: () => ({ x: 0, y: 0, width: 2, height: 1 }) },
      '../graphics/plane': { flattenPlanes: planes => planes[0] },
    })[name] ?? {},
    console,
  });
  // Exercise the real launch method with a strict compositor boundary. App
  // construction paints synchronously, as Nightscout's tray subscription does.
  const controller = Object.create(api.IosPreviewController.prototype);
  controller.inProcessApps = new Map();
  controller.requestShellRender = () => {};
  controller.scheduleFrame = () => {};
  controller.compositor = {
    configureSurface(id) { surfaces.add(id); }, setSurfaceVisible() {},
    removeSurface(id) { surfaces.delete(id); },
    submitSurfaceFrame(id, pixels) { assert.ok(surfaces.has(id), `unconfigured ${id}`); submitted.push([...pixels]); },
  };
  let plumbing, early;
  const fresh = [{ pixels: new Uint8Array([30, 40]), width: 2, height: 1 }];
  await controller.launchInProcessApp('nightscout', 'window:nightscout', options => {
    plumbing = options;
    early = options.submitFrame([{ pixels: new Uint8Array([10, 20]), width: 2, height: 1 }]);
    return { window: { windowId: 'nightscout', surfaceId: 'window:nightscout', appId: 'nightscout' },
      requestRender: () => options.submitFrame(fresh) };
  });
  await early;
  assert.deepEqual(submitted, [[30, 40]]);
  plumbing.removeSurface();
  await plumbing.submitFrame(fresh);
  assert.deepEqual(submitted, [[30, 40]], 'late callbacks cannot submit to a removed surface');
});

test('iOS compositor rejects missing and removed surfaces before crossing into Kotlin', () => {
  let nativeSubmissions = 0;
  const native = { configureIdXYWidthHeightZOrderTransparent() {}, removeId() {}, submitIdDataXYWidthHeight() { nativeSubmissions++; } };
  const api = load('app/graphics/surface-compositor.ios.ts', {
    require: () => ({ toData: data => data }),
    FaceclawKitIosSurfaceCompositor: { alloc: () => ({ initWithWidthHeight: () => native }) },
  });
  const c = new api.SurfaceCompositor(2, 1), pixels = new Uint8Array([1, 2]);
  const rect = { x: 0, y: 0, width: 2, height: 1 };
  assert.throws(() => c.submitSurfaceFrame('nightscout', pixels, rect), /Unknown surface/);
  c.configureSurface('nightscout', { ...rect, zOrder: 0, transparency: 'opaque' });
  c.submitSurfaceFrame('nightscout', pixels, rect);
  c.removeSurface('nightscout');
  assert.throws(() => c.submitSurfaceFrame('nightscout', pixels, rect), /Unknown surface/);
  assert.equal(nativeSubmissions, 1);
});
