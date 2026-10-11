const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const images = require('../.test-build/app/graphics/image.js');
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
const LAUNCHER_GRAY = 75;

function fixture() {
  const observers = new Map(), phoneState = { protectedDataAvailable: true };
  let settingsChanged, remoteHost, controller, bridge = null;
  let now = 1000, nextTask = 0, screenOn = true, shellOptions;
  const tasks = new Map(), sent = [], previews = [], received = [], errors = [];
  const boardStats = { starts: 0, stops: 0, paints: 0 };
  const settings = { lock: true, enabled: true, tap: true, hold: true, tilt: true, duration: 3000, depth: 0 };
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
  const launcherPixels = new Uint8Array(640 * 480).fill(LAUNCHER_GRAY), fullRect = { x: 0, y: 0, width: 640, height: 480 };
  const window = { windowId: 'launcher', surfaceId: 'launcher', appId: 'launcher', title: 'Apps',
    // The launcher repaints into whichever display target the controller has after a switch.
    requestRender() { void controller?.displayReady.then(() => controller.display?.submitSurfaceFrame('launcher', launcherPixels, fullRect, 'launcher')); }, setScreenOn() {} };
  const shell = {
    configure: options => { shellOptions = options; }, registerWindow() {}, focusWindow() {},
    wake: () => { screenOn = true; shellOptions.onScreenStateChanged(true); },
    sleep: () => { screenOn = false; shellOptions.onScreenStateChanged(false); },
    isScreenOn: () => screenOn, getWindows: () => [window], foregroundWindow: () => window,
    setBatteryLevels() {}, underlayDim: () => 1, getFocus: () => 'app', hasOverlay: () => false,
    describeInputTarget: () => 'test app',
    paintScene: () => new Uint8Array([0, 0]), paintSurface: () => [{ image: new images.GrayImage(640, 480, 0), x: 0, y: 0 }],
    receiveInput: async input => {
      received.push(input);
      if (input.type === 'display-wake' || !screenOn && input.type === 'double-click') shell.wake();
    },
  };
  // Both display targets share a minimal compositor (z-ordered opaque and
  // color-keyed surfaces, visibility, blanking) so the pixel assertions below
  // exercise layering, blanking and lock surfaces.
  class Display {
    surfaces = new Map(); blanked = false; depths = [];
    async configureCompositorScreen() {}
    async configureSurface(id, options) {
      const previous = this.surfaces.get(id);
      const pixels = previous?.width === options.width && previous.height === options.height
        ? previous.pixels : new Uint8Array(options.width * options.height);
      this.surfaces.set(id, { ...options, pixels, visible: previous?.visible ?? true });
    }
    async removeSurface(id) { this.surfaces.delete(id); this.changed(); }
    async setSurfaceVisible(id, visible) { const surface = this.surfaces.get(id); if (surface) surface.visible = visible; this.changed(); }
    async setSurfaceDepth(id, depth) { this.depths.push([id, depth]); }
    async setUnderlayDim() { this.changed(); }
    async setScreenBlanked(blanked) { this.blanked = blanked; this.changed(); }
    async submitSurfaceFrame(id, pixels, rect) {
      const surface = this.surfaces.get(id);
      if (!surface) throw new Error(`Unknown surface: ${id}`);
      for (let y = 0; y < rect.height; y++) {
        surface.pixels.set(pixels.subarray(y * rect.width, (y + 1) * rect.width), (rect.y + y) * surface.width + rect.x);
      }
      this.changed();
    }
    async submitShellScene() { this.changed(); }
    getCompositePreview() {
      const output = new Uint8Array(640 * 480);
      if (this.blanked) return output;
      for (const s of [...this.surfaces.values()].filter(s => s.visible).sort((a, b) => a.zOrder - b.zOrder)) {
        for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) {
          const value = s.pixels[y * s.width + x];
          if (s.transparency !== 'color-key' || value) output[(s.y + y) * 640 + s.x + x] = value;
        }
      }
      return output;
    }
    changed() {}
  }
  class PreviewDisplayTarget extends Display {
    activate(fn) { this.onFrame = fn; } release() { this.onFrame = null; }
    changed() { this.onFrame?.(); }
    waitForFrameFinished() { return Promise.resolve('composited'); }
  }
  const noop = () => () => {};
  class FaceclawCommunicatorBridge extends Display {
    phase = 'disconnected'; listeners = {};
    constructor() { super(); bridge = this; }
    on(kind, fn) { this.listeners[kind] = fn; return () => { if (this.listeners[kind] === fn) delete this.listeners[kind]; }; }
    onStateChange(fn) { return this.on('state', fn); } onRingEvent(fn) { return this.on('ring', fn); }
    onWearState(fn) { return this.on('wear', fn); } onBatteryState() { return noop(); } onFirmwareInfo() { return noop(); }
    onFrameMetrics() { return noop(); } addCompassListener() { return noop(); } onAncsRelayFrame() { return noop(); }
    onAncsAuthorization() { return noop(); } setRequiresAncs() {} rightWriteLimit() { return 20; } onPhoneLockSignal() {}
    async writeRawToRight() {} async configureBrightness() {} async setBrightness() {} async enableWearDetectionAndRequestState() {} async playBuzzerSequence() {} async close() {}
    emitState(phase, status = phase) { if (phase === 'connected' || phase === 'disconnected') this.phase = phase; this.listeners.state?.({ phase, status }); }
    emitRing(input) { this.listeners.ring?.(input); }
    emitWear(wearing) { this.listeners.wear?.(wearing); }
    async start() { this.emitState('connected', 'Connected.'); }
    async disconnect() { this.emitState('disconnected', 'Disconnected.'); }
    waitForFrameFinished() { return Promise.resolve('sent'); }
    changed() { if (this.phase === 'connected') sent.push(this.getCompositePreview()); }
  }
  const provider = {
    isEnabled: () => settings.enabled, showOnTap: () => settings.tap,
    showOnLongPress: () => settings.hold, showOnHeadTilt: () => settings.tilt,
    tapTimeoutMs: () => settings.duration, depth: () => settings.depth,
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
    '../native/ios-voice-input': { iosVoiceInput: { handleSessionEnded() {}, stopPhoneCapture() {} } },
    '../native/faceclaw-communicator.ios': { FaceclawCommunicatorBridge, resolveIosPeripherals: async addresses => addresses },
    '../native/preview-display.ios': { PreviewDisplayTarget },
    './ancs-client': { ANCS_FIRMWARE_VERSION: 16, AncsClient: class { state = 'disconnected'; start() {} stop() {} stopCommand() { return new Uint8Array(); } receive() { return false; } } },
    '../native/nightscout-bridge': { nightscoutBridge: { async start() {}, async stop() {} } },
    '../native/weather': { weatherBridge: { setSessionActive() {} } },
    './glance-host': { GlanceHost }, './events': events,
    './lock-screen': { LOCK_SCREEN_SURFACE_ID: 'lock-screen', createLockScreenImage: () => new images.GrayImage(640, 480, 123) },
    './glasses-presence': load('app/g2/glasses-presence.ts', {}),
    './device-addresses': { loadDeviceAddresses: () => ({ right: 'AA', left: 'BB', ring: '' }) }, './ios-peripheral-identity': { deviceAddressError: () => null },
    './firmware-compat': load('app/g2/firmware-compat.ts', {}), './reconnect-policy': load('app/g2/reconnect-policy.ts', {}),
    '../apps/launcher': { launcherEntries: () => [] },
    '../apps/evenhub/installed-apps': {}, '../apps/evenhub/manager': {}, '../apps/evenhub/updates': {}, '../apps/evenhub': {},
    '../apps/launcher/launcher-app': { createLauncherWindow: () => window, LAUNCHER_SURFACE_ID: 'launcher' },
    '../apps/all-apps': { ALL_APPS: [{ appId: 'glanceboard', glanceboard: provider }] },
    '../apps/onboarding/onboarding-progress': { claimGlassesOnboardingAutoLaunch: () => false },
    '../ui/shell/worker-window': {}, '../ui/shell/in-process-window': {},
    '../ui/dashboard-settings': { brightnessSetting: { get: () => 'auto' }, brightnessSettingToLevel: () => null, getBrightnessPreferences: () => ({ auto: true, level: 50, minimum: 2, maximum: 100, curve: '0:0,1000:100', fadeMs: 280 }), lockScreenEnabledSetting: { get: () => settings.lock }, onAnySettingChanged: fn => { settingsChanged = fn; return () => {}; }, previewColorSetting: { get: () => 'white' } },
    '../native/phone-battery': { readPhoneBatteryState: () => ({ battery: 80, charging: false }) },
    '../apps/ios-availability': { iosAppUnavailableReason: () => null },
    '../graphics/glyph-wire': { prepareFrameDraws: () => null },
    '../graphics/plane': planes, '../graphics/image': images,
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
  controller = new IosPreviewController((pixels, title) => previews.push({ pixels, title }), message => errors.push(message));
  window.requestRender();
  controller.resume();
  async function drain() { await controller.inputQueue; await controller.glance.queue; }
  async function advance(ms) {
    now += ms;
    for (const [id, task] of [...tasks]) if (task.at <= now && tasks.delete(id)) task.fn();
    await drain();
  }
  async function render() { await drain(); await advance(33); await drain(); assert.deepEqual(errors, []); }
  async function hardware(type, source = 2, ringTick) {
    const input = { kind: type === 12 ? 'display-wake' : 'sys-event', containerName: '', eventType: type, eventSource: source,
      systemExitReasonCode: 0, frameId: 0 };
    if (ringTick !== undefined) input.ringInput = { type: type === 3 ? 2 : 1, tick: ringTick, aux: 0, speed: 0 };
    bridge.emitRing(input);
    await render();
  }
  async function phone(type, origin = 'ring') { controller.gesture(type, origin); await render(); }
  async function connect() { await controller.connect(); await render(); }
  return { controller, shell, remoteHost, keyboardChanged: session => shellOptions.onKeyboardInputChanged(session), settings, phoneState, observers,
    get bridge() { return bridge; }, connect, wear: wearing => bridge.emitWear(wearing), settingsChanged: () => settingsChanged(), sent, previews, received, boardStats, hardware, phone, advance, render };
}
const assertBlank = pixels => assert.ok(pixels.every(p => p === 0));
const assertBoard = pixels => {
  assert.equal(pixels[48 * 640 + 270], 200);
  assert.equal(pixels[0], 0, 'opaque Glanceboard hides the retained app and shell');
};

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

