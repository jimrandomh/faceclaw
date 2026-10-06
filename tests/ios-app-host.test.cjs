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

test('iOS worker replies keep cached draw references paired with their baked pixels', () => {
  const replies = [], received = [];
  const wrap = buffer => ({ length: buffer.byteLength, buffer,
    base64EncodedStringWithOptions: () => Buffer.from(buffer).toString('base64') });
  const NSData = {
    dataWithBytesLength: buffer => wrap(buffer),
    alloc: () => ({ initWithBase64EncodedStringOptions: text => {
      const bytes = Uint8Array.from(Buffer.from(text, 'base64')); return wrap(bytes.buffer);
    } }),
  };
  const interop = { handleof: buffer => buffer, bufferFromData: data => data.buffer };
  const display = load('app/native/active-display.ios.ts', {
    NSData, interop, global: { postMessage: message => replies.push(message) },
  }).getActiveDisplay();
  const pixels = new Uint8Array([255, 0, 0, 255]), draws = new Uint8Array([1, 7, 0, 0, 0, 0, 0, 0, 0]);
  display.submitSurfaceFrame(pixels.buffer, 'window:test', 0, 0, 2, 2, 'frame', 0, 1, draws.buffer);
  const worker = {};
  const { WorkerAppHost } = load('app/ui/shell/worker-window.ts', {
    require: () => ({}), global: { isIOS: true }, NSData, interop,
  });
  const host = new WorkerAppHost({ appId: 'test', worker, submitPixels: (...args) => received.push(args) });
  host.openWindows.add('test');
  worker.onmessage({ data: replies[0] });
  assert.equal(received.length, 1);
  assert.deepEqual([...received[0][1]], [...pixels]);
  assert.deepEqual([...new Uint8Array(received[0][4])], [...draws]);
  display.submitSurfaceFrame(pixels.buffer, 'window:test', 0, 0, 2, 2);
  worker.onmessage({ data: replies[1] });
  assert.equal(received[1][4], null, 'a pixel-only update must clear previous draw identities');
  host.openWindows.clear(); worker.onmessage({ data: replies[0] });
  assert.equal(received.length, 2, 'closed windows cannot deliver stale cached draws');
});

test('iOS installed apps launch, recover missing packages, and close before uninstall', async () => {
  const calls = [], app = { packageId: 'test.app', name: 'Test' };
  let present = true;
  const modules = {
    "../ui/input-monitor": load("app/ui/input-monitor.ts", {}),
    '../apps/all-apps': { ALL_APPS: [{ appId: 'evenhub' }] },
    '../apps/evenhub/installed-apps': { getInstalledEvenHubAppById: id => id === 'installed' ? app : null,
      installedEvenHubPackageId: id => id === 'installed' ? app.packageId : null,
      uninstallEvenHubPackage: id => calls.push(['uninstall', id]) },
    '../apps/evenhub/updates': { isInstalledPackagePresent: () => present },
    '../apps/evenhub': { openEvenHubStoreForPackage: (_ctx, value) => calls.push(['reinstall', value.packageId]) },
    '../apps/evenhub/manager': { launchInstalledPackage: (ctx, value) => calls.push(['launch', ctx.appId, value.packageId]),
      closeRunningPackage: id => calls.push(['close', id]) },
  };
  const { IosPreviewController } = load('app/g2/ios-preview-controller.ts', { require: id => modules[id] ?? {} });
  const host = Object.create(IosPreviewController.prototype);
  host.buildAppContext = app => app; host.fail = assert.fail; host.requestShellRender = () => {};
  await host.launchApp('installed'); present = false; await host.launchApp('installed');
  await host.uninstallApp('installed');
  assert.deepEqual(calls, [['launch', 'installed', 'test.app'], ['reinstall', 'test.app'], ['close', 'test.app'], ['uninstall', 'test.app']]);
});

test('iOS settings prompts honor password input and report cancellation', async () => {
  const prompts = [], writes = [];
  const { IosPreviewController } = load('app/g2/ios-preview-controller.ts', { require: id => id === '@nativescript/core' ? {
    Dialogs: { prompt: async options => { prompts.push(options); return { result: false, text: 'discarded' }; } },
  } : {} });
  const host = Object.create(IosPreviewController.prototype); host.active = true;
  const accepted = await host.editSetting({ editorTitle: 'Password', inputKind: 'password', get: () => '', set: value => writes.push(value) });
  assert.equal(prompts[0].inputType, 'password');
  assert.equal(accepted, false); assert.deepEqual(writes, []);
});

test('iOS host forwards hands-free capture mode to the voice bridge', async () => {
  const captures = [];
  const { IosPreviewController } = load('app/g2/ios-preview-controller.ts', { require: id => id === '../native/ios-voice-input'
    ? { iosVoiceInput: { startGlassesCapture: (_session, _log, endpointing) => captures.push(endpointing) } } : {} });
  const host = Object.create(IosPreviewController.prototype);
  host.communicator = {}; host.state = { phase: 'connected' };
  await host.startVoiceCapture(true);
  await host.startVoiceCapture();
  assert.deepEqual(captures, [true, false]);
});

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
  const api = load('app/ui/dashboard-settings.ts', { global: { isIOS: true },
    require: id => id.includes('settings-store') ? { onSettingsStoreChanged: fn => listeners.push(fn) }
      : { Layer: class {}, ASSISTANT_MODEL_CHOICES: [] },
    setTimeout: fn => tasks.push(fn),
  });
  api.onAnySettingChanged(() => painted.push(cachedFont));
  listeners.push(() => { cachedFont = 'Bold'; });
  for (const listener of listeners) listener('display.uiFont2');
  while (tasks.length) tasks.shift()();
  assert.deepEqual(painted, ['Bold']);
});

test('iOS bandwidth footer toggles live, polls only in foreground and resets its rate window on resume', () => {
  const views = [], intervals = new Map(), appEvents = new Map(), settingListeners = new Set();
  let enabled = false, atMs = 0, totals = { messages: 0, bytes: 0, frames: 0 }, nextId = 0;
  class View {
    events = new Map(); children = [];
    constructor() { views.push(this); }
    on(event, fn) { this.events.set(event, fn); }
    addChild(view) { this.children.push(view); }
    set(key, value) { this[key] = value; }
    notifyPropertyChange() {}
    getActualSize() { return { width: 0, height: 0 }; }
    getViewById() { return null; }
    static setRow() {} static setColumn() {}
  }
  const core = { Application: { suspendEvent: 'suspend', resumeEvent: 'resume',
    on: (key, fn) => appEvents.set(key, fn), off: key => appEvents.delete(key) },
    Builder: { load: () => new View() }, Observable: View, Button: View, Color: class {}, Dialogs: {}, GridLayout: View, Image: View, Label: View, Page: View, StackLayout: View };
  const modules = {
    "../ui/input-monitor": load("app/ui/input-monitor.ts", {}),
    '../assistant/system-tools': { registerSystemTools() {} },
    '../assistant/window-tools': { registerWindowTools() {} },
    '../assistant/navigate-tools': { registerNavigateTools() {} },
    '../assistant/roam-tools': { registerRoamTools() {} },
    "../native/ios-navigation-sensors": {},
    '../native/notification-icons.ios': { bindIosNotifications() {}, iosNotificationsChanged() {}, onIosNotificationPopup: () => () => {}, readActiveNotifications: () => [] },
    '../native/notification-sources': { shouldShowNotificationOnGlasses: () => true },
    '../native/compass.ios': { bindCompassSession() {}, receiveCompassEvent() {} },
    '@nativescript/core': core,
    '../apps/launcher': { launcherEntries: () => [] },
    '../apps/all-apps': { ALL_APPS: [] },
    '../g2/ios-preview-controller': { IosPreviewController: class { resume() {} pause() {} } },
    './phone-gestures': { PhoneGestureRecognizer: class { cancel() {} } },
    './ble-bandwidth-meter': require('../.test-build/app/phone-ui/ble-bandwidth-meter.js'),
    '../native/ble-traffic': { sampleBleTraffic: () => totals },
    '../ui/dashboard-settings': { brightnessSetting: { get: () => 'auto' }, displayModeSetting: { get: () => 'full' }, displayModeLabel: () => 'Full', showBleBandwidthSetting: { get: () => enabled },
      onAnySettingChanged: fn => { settingListeners.add(fn); return () => settingListeners.delete(fn); } },
    '../g2/device-addresses': { loadDeviceAddresses: () => ({}) },
    '../g2/ios-peripheral-identity': { deviceAddressError: () => 'no test devices' },
    './onboarding-state': { isPreviewOnlyMode: () => false },
    '../g2/reconnect-policy': { isAutoReconnectSuppressed: () => false },
  };
  modules['./keyboard-input-view-model'] = load('app/phone-ui/keyboard-input-view-model.ts', { require: id => modules[id] });
  modules['./remote-controls-view-model'] = load('app/phone-ui/remote-controls-view-model.ts', { require: id => modules[id] });
  const { createMainPage } = load('app/phone-ui/main-page.ios.ts', {
    require: id => modules[id] ?? {}, Date: { now: () => atMs },
    NSNotificationCenter: { defaultCenter: { addObserverForNameObjectQueueUsingBlock: () => ({}), removeObserver() {} } },
    UIKeyboardWillChangeFrameNotification: 'keyboard', NSOperationQueue: { mainQueue: {} },
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
      '../graphics/plane': { flattenPlanesWithDraws: planes => ({ image: planes[0], draws: [] }), planesFingerprint: () => 'fp' },
      '../graphics/glyph-wire': { prepareFrameDraws: () => null },
    })[name] ?? {},
    console,
  });
  // Exercise the real launch method with a strict display boundary. App
  // construction paints synchronously, as Nightscout's tray subscription does.
  const controller = Object.create(api.IosPreviewController.prototype);
  controller.inProcessApps = new Map();
  controller.requestShellRender = () => {};
  controller.schedulePreviewUpdate = () => {};
  controller.communicator = null;
  controller.previewTarget = {
    async configureSurface(id) { surfaces.add(id); }, async setSurfaceVisible() {},
    async removeSurface(id) { surfaces.delete(id); },
    async submitSurfaceFrame(id, pixels) { assert.ok(surfaces.has(id), `unconfigured ${id}`); submitted.push([...pixels]); },
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
  const native = { configureIdXYWidthHeightZOrderTransparent() {}, removeId() {}, submitDrawsIdDataXYWidthHeightDraws() { nativeSubmissions++; } };
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

test('iOS welcome sound waits for a new acknowledged frame and is consumed once', async () => {
  let pending = true;
  const played = [], sounds = load('app/ui/sound-effects.ts', { require: name => { assert.equal(name, '../g2/cfw-message-type'); return load('app/g2/cfw-message-type.ts', {}); } });
  const { IosPreviewController } = load('app/g2/ios-preview-controller.ts', {
    require: id => ({
      '../phone-ui/onboarding-state': { isWelcomeSoundPending: () => pending, setWelcomeSoundPending: value => { pending = value; } },
      '../ui/sound-effects': sounds,
    })[id] ?? {},
    setTimeout: fn => { fn(); return 1; },
  });
  const host = Object.create(IosPreviewController.prototype);
  host.acknowledgedFrames = 0;
  host.actions = { playBuzzerSequence: bytes => played.push([...bytes]) };
  host.logBluetooth = assert.fail;
  host.maybePlayWelcomeSound({ phase: 'connecting', frames: 0 });
  host.maybePlayWelcomeSound({ phase: 'connected', frames: 0 });
  assert.equal(pending, true); assert.equal(played.length, 0);
  host.maybePlayWelcomeSound({ phase: 'connected', frames: 1 });
  assert.equal(pending, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(played.length > 0);
  const count = played.length;
  host.maybePlayWelcomeSound({ phase: 'connected', frames: 1 });
  host.maybePlayWelcomeSound({ phase: 'connected', frames: 2 });
  assert.equal(played.length, count);
});

test('iOS preview voice uses the phone microphone, while connected capture stays on glasses', async () => {
  const calls = [];
  const bridge = { prepare: async (foreground, phone) => { calls.push(['prepare', foreground, phone]); return true; },
    startPhoneCapture: async (_log, endpointing) => calls.push(['phone', endpointing]),
    startGlassesCapture: async (_session, _log, endpointing) => calls.push(['glasses', endpointing]) };
  const { IosPreviewController } = load('app/g2/ios-preview-controller.ts', {
    require: id => id === '../native/ios-voice-input' ? { iosVoiceInput: bridge } : {},
  });
  const host = Object.create(IosPreviewController.prototype);
  host.active = true; host.glassesLocked = false; host.communicator = null; host.state = { phase: 'disconnected' };
  assert.equal(await host.prepareVoiceCapture(), true);
  await host.startVoiceCapture(true);
  assert.deepEqual(calls, [['prepare', true, true], ['prepare', true, true], ['phone', true]]);
  calls.length = 0; host.communicator = {}; host.state = { phase: 'connected' };
  assert.equal(await host.prepareVoiceCapture(), true); await host.startVoiceCapture(false);
  assert.deepEqual(calls, [['prepare', true, false], ['glasses', false]]);
  calls.length = 0; host.active = false; host.communicator = null; host.state = { phase: 'disconnected' };
  assert.equal(await host.prepareVoiceCapture(), false); await host.startVoiceCapture();
  assert.deepEqual(calls, []);
});

test('iOS keyboard action opens the shared destination session and remains blocked while locked', () => {
  let opened = 0;
  const { IosPreviewController } = load('app/g2/ios-preview-controller.ts', {
    require: id => id === '../ui/shell/shell' ? { shell: { startKeyboardInput: () => opened++ } } : {},
  });
  const host = Object.create(IosPreviewController.prototype);
  host.active = true; host.glassesLocked = false; host.typeIntoApp(); assert.equal(opened, 1);
  host.glassesLocked = true; host.typeIntoApp(); assert.equal(opened, 1);
  host.glassesLocked = false; host.active = false; host.typeIntoApp(); assert.equal(opened, 1);
});

test('iOS curve editor retains invalid draft and retries Save with a validation message', async () => {
  const prompts = [], errors = [], saved = [];
  const answers = [{ result: true, text: '0:0,5:' }, { result: true, text: '0:0,5:100' }];
  const { IosPreviewController } = load('app/g2/ios-preview-controller.ts', { require: id => id === '@nativescript/core'
    ? { Dialogs: { prompt: async options => { prompts.push(options.defaultText); return answers.shift(); }, alert: async options => errors.push(options.message) } }
    : {} });
  const host = Object.create(IosPreviewController.prototype); host.active = true;
  const curve = require('../.test-build/app/g2/brightness-curve.js');
  assert.equal(await host.editSetting({ editorTitle: 'Auto light curve', get: () => '0:0,8:100',
    set: value => saved.push(value), validationError: curve.brightnessCurveError }), true);
  assert.deepEqual(prompts, ['0:0,8:100', '0:0,5:']);
  assert.equal(errors.length, 1);
  assert.deepEqual(saved, ['0:0,5:100']);
});
