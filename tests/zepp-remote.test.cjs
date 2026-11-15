const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loader } = require('./helpers/load-typescript.cjs');
const protocol = require('../.test-build/app/remote/protocol.js');

function fixture() {
  let saved = '[]';
  const calls = [];
  const state = { phase: 'connected', status: 'Connected', glassesLocked: false,
    glassesWorn: true, silentMode: false, lastHeadsetBattery: 72 };
  const preferences = { remoteEnabled: true, canUnlock: false };
  const windows = [{ windowId: 'transcribe-1', appId: 'transcribe', title: 'Transcribe', closeable: true },
    { windowId: 'launcher', appId: 'launcher', title: 'Launcher', closeable: false }];
  const shell = {
    getBatteryLevels: () => ({}), foregroundWindow: () => windows[0],
    getForegroundApp: () => windows[0], getWindows: () => windows,
    isScreenOn: () => true, isAssistantAvailable: () => false,
    wake: () => { calls.push(['wake']); return true; },
    focusWindow: id => calls.push(['focus', id]),
    closeWindow: id => { calls.push(['close', id]); windows.splice(windows.findIndex(w => w.windowId === id), 1); },
  };
  const constant = value => ({ get: () => value });
  const load = loader({ global: { isAndroid: true }, setTimeout: () => 1 }, {
    '../analytics/analytics': { flagAnalyticsEvent() {} },
    '../apps/evenhub/installed-apps': {
      getInstalledEvenHubApps: () => [{ packageId: 'org.example.news', name: 'News' }],
      installedEvenHubAppId: id => 'evenhub:' + id,
    },
    // Zepp must work even if Google Play Services/Wear OS transport is unavailable.
    '../native/wear-bridge': { wearBridge: { isAvailable: () => false }, WEAR_PATHS: {} },
    '../ui/dashboard-settings': {
      glassesModelName: () => 'G2',
      watchRemoteEnabledSetting: { get: () => preferences.remoteEnabled },
      watchCanUnlockSetting: { get: () => preferences.canUnlock },
      watchCrownClockwiseNextSetting: constant(false), watchVibrateOnInputSetting: constant(true),
      watchSoundEffectsSetting: constant(false), watchMirrorAssistantSetting: constant(false),
    },
    '../ui/shell/shell': { shell },
    '../ui/shell/voice-activity': { voiceActivity: { isActive: () => false } },
    '../version': { FACECLAW_VERSION: 'test' },
    '../remote/protocol': protocol,
  });
  const { WearRemote } = load('app/g2/wear-remote.ts');
  const wearHost = {
    apps: () => [{ appId: 'transcribe', title: 'Transcribe' }],
    injectInput: async gesture => calls.push(['gesture', gesture]),
    launchApp: async id => calls.push(['launch', id]),
    connect: async () => calls.push(['connect']), disconnect: async () => calls.push(['disconnect']),
    setGlassesLocked: locked => { state.glassesLocked = locked; calls.push(['lock', locked]); },
    requestShellRender() {}, getState: () => state, appendLog() {},
  };
  const remote = new WearRemote(wearHost);
  const tokens = new protocol.TokenStore(() => saved, text => { saved = text; },
    () => crypto.randomBytes(32).toString('hex'), value => crypto.createHash('sha256').update(value).digest('hex'));
  const { token, record } = tokens.create('Balance', ['input']);
  const host = { ready: () => state.phase === 'connected', locked: () => state.glassesLocked,
    input: async (gesture, source) => calls.push(['input', gesture, source]),
    watchControlEnabled: () => remote.controlEnabled(),
    watchState: () => remote.buildState(), watchCommand: payload => remote.executeCommand(payload) };
  const request = payload => protocol.handleRequest(JSON.stringify({ version: 1, token, ...payload }), tokens, host);
  return { calls, state, preferences, windows, remote, wearHost, tokens, record, request };
}

test('Zepp retrieves built-in and installed app IDs and exact running window IDs without Wear OS', async () => {
  const f = fixture(); f.state.phase = 'disconnected';
  const reply = await f.request({ action: 'watch-state' });
  assert.equal(reply.ok, true);
  assert.equal(reply.state.connected, false);
  assert.deepEqual(JSON.parse(JSON.stringify(reply.state.apps)), [
    { appId: 'transcribe', title: 'Transcribe' }, { appId: 'evenhub:org.example.news', title: 'News' },
  ]);
  assert.equal(reply.state.windows[0].windowId, 'transcribe-1');
  assert.deepEqual(f.calls, []);
});

test('Zepp launch, focus and close use real WearRemote handlers and close only the requested window', async () => {
  const f = fixture();
  assert.equal((await f.request({ action: 'watch-command', command: 'launch-app', appId: 'evenhub:org.example.news' })).ok, true);
  assert.equal((await f.request({ action: 'watch-command', command: 'focus-window', windowId: 'transcribe-1' })).ok, true);
  assert.equal((await f.request({ action: 'watch-command', command: 'close-window', windowId: 'transcribe-1' })).ok, true);
  assert.deepEqual(f.calls.filter(call => call[0] !== 'wake'), [
    ['launch', 'evenhub:org.example.news'], ['focus', 'transcribe-1'], ['close', 'transcribe-1'],
  ]);
  assert.deepEqual(f.windows.map(w => w.windowId), ['launcher']);
  assert.equal((await f.request({ action: 'watch-command', command: 'close-window', windowId: 'transcribe-1' })).ok, false);
  assert.equal((await f.request({ action: 'watch-command', command: 'close-window', windowId: 'launcher' })).ok, false);
});

test('Zepp cannot bypass disabled watch controls or the glasses lock', async () => {
  const f = fixture();
  const open = { action: 'watch-command', command: 'launch-app', appId: 'transcribe' };
  f.preferences.remoteEnabled = false;
  assert.match((await f.request(open)).message, /turned off/);
  assert.match((await f.request({ action: 'input', gesture: 'click', source: 'watch' })).message, /turned off/);
  assert.match((await f.request({ action: 'input', gesture: 'scroll-down' })).message, /turned off/);
  f.preferences.remoteEnabled = true; f.state.glassesLocked = true;
  assert.match((await f.request(open)).message, /locked/);
  assert.match((await f.request({ action: 'watch-command', command: 'unlock' })).message, /turned off/);
  assert.deepEqual(f.calls, []);
  f.preferences.canUnlock = true;
  assert.equal((await f.request({ action: 'watch-command', command: 'unlock' })).ok, true);
  assert.equal(f.state.glassesLocked, false);
});

test('disconnection rejects app operations but permits explicit connect', async () => {
  const f = fixture(); f.state.phase = 'disconnected';
  assert.equal((await f.request({ action: 'watch-command', command: 'launch-app', appId: 'transcribe' })).ok, false);
  assert.equal((await f.request({ action: 'watch-command', command: 'connect' })).ok, true);
  assert.deepEqual(f.calls, [['connect']]);
});

test('connect acknowledges immediately even when BLE connection is still pending', async () => {
  const f = fixture(); f.state.phase = 'disconnected';
  f.wearHost.connect = () => new Promise(() => {});
  const reply = await Promise.race([
    f.request({ action: 'watch-command', command: 'connect' }),
    new Promise(resolve => setTimeout(() => resolve({ ok: false, message: 'test timed out' }), 100)),
  ]);
  assert.equal(reply.ok, true);
  assert.equal(reply.message, 'Connecting...');
});

test('the Watch setting does not disable explicitly authorized ring-source input', async () => {
  const f = fixture(); f.preferences.remoteEnabled = false;
  assert.equal((await f.request({ action: 'input', gesture: 'click', source: 'ring' })).ok, true);
  assert.deepEqual(f.calls, [['input', 'click', 'ring']]);
});

test('authentication and input permission protect state reads and commands, including after revocation', async () => {
  const f = fixture();
  for (const payload of [{ action: 'watch-state' }, { action: 'watch-command', command: 'launch-app', appId: 'transcribe' }]) {
    assert.equal((await f.request({ ...payload, token: 'bad' })).error, 'unauthorized');
    f.tokens.permissions(f.record.id, ['text']);
    assert.equal((await f.request(payload)).error, 'forbidden');
  }
  f.tokens.revoke(f.record.id);
  assert.equal((await f.request({ action: 'watch-state' })).error, 'unauthorized');
  assert.deepEqual(f.calls, []);
});

test('malformed and stale IDs cannot launch another app or fall back to a foreground close', async () => {
  const f = fixture();
  for (const command of [
    { command: 'launch-app' }, { command: 'launch-app', appId: 2 },
    { command: 'launch-app', appId: 'unknown' }, { command: 'close-window', windowId: '' },
    { command: 'close-window', windowId: 'no-longer-open' }, { command: 'launch-app', appId: 'a\0b' },
    { command: 'close-window', windowId: 'x'.repeat(513) }, { command: 'delete-app', appId: 'transcribe' },
  ]) assert.equal((await f.request({ action: 'watch-command', ...command })).ok, false);
  assert.deepEqual(f.calls, []);
});
