const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');

function load(file, context = {}) {
  const sandbox = { exports: {}, console, ...context };
  sandbox.global = sandbox;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, sandbox);
  return sandbox.exports;
}
const types = () => load('app/native/wear-bridge-types.ts');

/** What FaceclawWatchBridge.m does, as far as JS can tell. */
function fakeNative({ available = true, watchApp = true } = {}) {
  return {
    calls: [], message: null, connection: null, watchApp,
    isAvailable() { return available; },
    isWatchAppAvailable() { return this.watchApp; },
    setMessageHandlerConnectionHandler(message, connection) { this.message = message; this.connection = connection; },
    publishStateForce(json, force) { this.calls.push(['state', JSON.parse(json), force]); },
    sendEventSticky(json, sticky) { this.calls.push(['event', JSON.parse(json), sticky]); },
    sendToWatchJson(pathName, json) { this.calls.push(['send', pathName, JSON.parse(json)]); },
    sendAckOkJsReadyMessage(seq, ok, jsReady, message) { this.calls.push(['ack', seq, ok, jsReady, message]); },
  };
}
function loadBridge(native) {
  return load('app/native/wear-bridge.ios.ts', {
    FaceclawWatchBridge: { shared: () => native },
    require: () => types(),
  }).wearBridge;
}

test('iOS bridge carries the same messages as the Android one', () => {
  const native = fakeNative();
  const bridge = loadBridge(native);
  assert.equal(bridge.isAvailable(), true);
  const received = [];
  bridge.onMessage(message => received.push(message));
  native.message('/faceclaw/input', '{"gesture":"click","seq":3}');
  native.message('/faceclaw/press', 'not json');
  assert.equal(received[0].path, '/faceclaw/input');
  assert.equal(received[0].payload.gesture, 'click');
  assert.equal(Object.keys(received[1].payload).length, 0, 'a malformed payload is empty, not a crash');

  bridge.publishState({ phase: 'connected' }, true);
  bridge.sendToWatch('/faceclaw/battery/request', {});
  bridge.sendAck(received[0].nodeId, 3, false, 'refused');
  assert.deepEqual(JSON.parse(JSON.stringify(native.calls)), [
    ['state', { phase: 'connected' }, true],
    ['send', '/faceclaw/battery/request', {}],
    ['ack', 3, false, true, 'refused'],
  ]);
});

test('only streaming assistant snapshots skip the sticky application context', () => {
  const native = fakeNative();
  const bridge = loadBridge(native);
  bridge.sendEvent({ type: 'assistant', phase: 'streaming', text: 'par' });
  bridge.sendEvent({ type: 'assistant', phase: 'done', text: 'partial' });
  bridge.sendEvent({ type: 'alert', text: 'hi' });
  assert.deepEqual(native.calls.map(call => call[2]), [false, true, true]);
});

test('availability follows the watch app, and a change reaches listeners', () => {
  const native = fakeNative({ watchApp: false });
  const bridge = loadBridge(native);
  const seen = [];
  bridge.onWatchConnection(connection => seen.push(connection.reachable));
  assert.deepEqual(seen, [false], 'the current value is delivered immediately');
  native.watchApp = true;
  native.connection();
  assert.deepEqual(seen, [false, true]);
  assert.equal(bridge.getWatchConnection().watchName, 'Apple Watch');
});

test('a phone that cannot use WatchConnectivity turns the bridge into a no-op', () => {
  const native = fakeNative({ available: false });
  const bridge = loadBridge(native);
  assert.equal(bridge.isAvailable(), false);
  bridge.publishState({});
  bridge.sendEvent({ type: 'alert', text: 'x' });
  assert.equal(bridge.getWatchConnection().reachable, false);
  assert.equal(native.calls.length, 0);
});

/** A WearRemote over a fake bridge and shell. */
function loadRemote({ phase = 'disconnected', preview = false, now = 1_800_000_000_000 } = {}) {
  const bridge = {
    messageListener: null, connectionListener: null, sent: [],
    isAvailable: () => true,
    onMessage(listener) { this.messageListener = listener; return () => {}; },
    onWatchConnection(listener) { this.connectionListener = listener; listener({ reachable: true, watchName: 'Apple Watch' }); return () => {}; },
    publishState() {},
    sendEvent() {},
    sendToWatch() {},
    sendAck(_node, seq, ok, message) { this.sent.push({ seq, ok, message }); },
  };
  const levels = { watch: null, watchCharging: null };
  const shell = {
    onAssistantActivity() {}, onAlertShown() {},
    getBatteryLevels: () => levels,
    setBatteryLevels(update) { Object.assign(levels, update); },
    foregroundWindow: () => null, getForegroundApp: () => null, getWindows: () => [],
    isScreenOn: () => true, wake: () => true, isAssistantAvailable: () => false,
  };
  const setting = value => ({ get: () => value });
  const intervals = [];
  const realDate = Date;
  const clock = { now };
  class FakeDate extends realDate { static now() { return clock.now; } }
  const inputs = [];
  const state = { phase, status: '', glassesLocked: false, glassesWorn: null, silentMode: false, lastHeadsetBattery: null };
  const { WearRemote } = load('app/g2/wear-remote.ts', {
    Date: FakeDate,
    setTimeout: () => 0, clearTimeout() {},
    setInterval: fn => { intervals.push(fn); return intervals.length; },
    Number, Math, JSON,
    require: id => ({
      '../analytics/analytics': { flagAnalyticsEvent() {} },
      '../apps/evenhub/installed-apps': { getInstalledEvenHubApps: () => [], installedEvenHubAppId: id => id },
      '../native/wear-bridge': { wearBridge: bridge, WEAR_PATHS: types().WEAR_PATHS },
      '../ui/dashboard-settings': {
        onAnySettingChanged() {}, watchCanUnlockSetting: setting(true), watchCrownClockwiseNextSetting: setting(false),
        watchMirrorAssistantSetting: setting(true), watchRemoteEnabledSetting: setting(true),
        watchVibrateOnInputSetting: setting(true), watchSoundEffectsSetting: setting(false),
      },
      '../ui/shell/shell': { shell },
      '../ui/shell/voice-activity': { voiceActivity: { subscribe() {}, isActive: () => false } },
      '../version': { FACECLAW_VERSION: 'test' },
    })[id] ?? {},
  });
  const remote = new WearRemote({
    apps: [{ appId: 'timer', title: 'Timer' }],
    injectInput: async kind => { inputs.push(kind); },
    launchApp: async () => {}, connect: async () => {}, disconnect: async () => {},
    setGlassesLocked() {}, requestShellRender() {},
    previewInputActive: () => preview,
    getState: () => state,
    appendLog() {},
  });
  const deliver = (pathName, payload) => bridge.messageListener({ path: pathName, payload, nodeId: 'apple-watch' });
  return { remote, bridge, shell, levels, inputs, intervals, clock, deliver };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('gestures are refused with no display, and land on the preview without glasses', async () => {
  const none = loadRemote();
  none.deliver('/faceclaw/input', { gesture: 'click', seq: 1 });
  none.deliver('/faceclaw/press', {});
  await settle();
  assert.deepEqual(none.inputs, []);
  assert.equal(none.bridge.sent[0].ok, false);
  assert.match(none.bridge.sent[0].message, /not connected/);

  const preview = loadRemote({ preview: true });
  preview.deliver('/faceclaw/press', {});
  preview.deliver('/faceclaw/input', { gesture: 'click', seq: 2 });
  await settle();
  assert.deepEqual(preview.inputs, ['ring-press', 'click']);
  assert.equal(preview.bridge.sent[0].ok, true);

  const glasses = loadRemote({ phase: 'connected' });
  glasses.deliver('/faceclaw/input', { gesture: 'swipe-left', seq: 3 });
  await settle();
  assert.deepEqual(glasses.inputs, ['swipe-left']);
});

test('a watch battery report is shown, kept while fresh, and dropped once stale', async () => {
  const { levels, intervals, clock, deliver, bridge } = loadRemote({ phase: 'connected' });
  deliver('/faceclaw/battery', { battery: 64, charging: true, at: clock.now });
  await settle();
  assert.equal(levels.watch, 64);
  assert.equal(levels.watchCharging, true);
  assert.equal(bridge.sent.length, 0, 'battery reports are never acked');

  const tick = () => intervals.forEach(fn => fn());
  clock.now += 3 * 60 * 60_000;
  tick();
  assert.equal(levels.watch, 64, 'a closed watch app reports rarely; three hours is still shown');
  clock.now += 2 * 60 * 60_000;
  tick();
  assert.equal(levels.watch, null, 'five hours says the watch is gone');
});

test('a battery report found long after it was left is not shown as current', async () => {
  const { levels, clock, deliver } = loadRemote({ phase: 'connected' });
  deliver('/faceclaw/battery', { battery: 90, charging: false, at: clock.now - 5 * 60 * 60_000 });
  await settle();
  assert.equal(levels.watch, null);
  // A live report without a timestamp is current by definition, as Wear OS's always are.
  deliver('/faceclaw/battery', { battery: 80, charging: false });
  await settle();
  assert.equal(levels.watch, 80);
});

test('a watch that does not know its battery shows no level, not an empty one', async () => {
  const { levels, deliver } = loadRemote({ phase: 'connected' });
  deliver('/faceclaw/battery', { battery: 50, charging: false });
  await settle();
  assert.equal(levels.watch, 50);
  deliver('/faceclaw/battery', { battery: null, charging: false });
  await settle();
  assert.equal(levels.watch, null);
});

test('the mirrored state carries the Apple Watch feedback settings', () => {
  const state = loadRemote({ preview: true }).remote.buildState();
  assert.equal(state.vibrateOnInput, true);
  assert.equal(state.soundEffects, false);
});

test('the mirrored state says when gestures are landing on the preview', () => {
  const state = loadRemote({ preview: true }).remote.buildState();
  assert.equal(state.preview, true);
  assert.equal(state.connected, false);
  assert.equal(loadRemote({ phase: 'connected' }).remote.buildState().connected, true);
});
