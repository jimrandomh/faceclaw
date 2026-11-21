const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { loader } = require('./helpers/load-typescript.cjs');

// Values built inside the loader's sandbox have its prototypes; compare as plain data.
const plain = value => JSON.parse(JSON.stringify(value));

/** The real bridge client over a recording socket and hand-run timers. */
function bridgeEnv({ ios = false } = {}) {
  const sockets = [], timeouts = new Map(), intervals = new Map();
  let nextTimer = 0;
  const load = loader({
    global: { isIOS: ios, isAndroid: !ios },
    setTimeout: (fn, ms) => { timeouts.set(++nextTimer, { fn, ms }); return nextTimer; },
    clearTimeout: id => timeouts.delete(id),
    setInterval: (fn, ms) => { intervals.set(++nextTimer, { fn, ms }); return nextTimer; },
    clearInterval: id => intervals.delete(id),
  }, {
    '../native/socket': { openSocket: (url, listener) => {
      const socket = { url, listener, sent: [], closed: false,
        sendText(text) { this.sent.push(JSON.parse(text)); return true; }, close() { this.closed = true; } };
      sockets.push(socket);
      return socket;
    } },
    './mcp-server': { AssistantMcpServer: class { handleMessage() {} sendToolsChanged() {} } },
    './tool-registry': { toolRegistry: { onToolsChanged: () => () => {} } },
  });
  const api = load('app/assistant/bridge-client.ts');
  const options = host => ({ host, port: 8790, token: 'secret', deviceName: 'faceclaw', allowProactive: () => true });
  const runTimeouts = () => { for (const [id, timer] of [...timeouts]) { timeouts.delete(id); timer.fn(); } };
  return { api, bridge: new api.AssistantBridgeClient(), sockets, timeouts, intervals, options, runTimeouts };
}

test('a bare bridge host dials plain ws on the bridge port; a ws:// or wss:// address is used as written', () => {
  const { api, bridge, sockets, options } = bridgeEnv();
  assert.equal(api.assistantBridgeUrl('100.64.0.7', 8790), 'ws://100.64.0.7:8790');
  assert.equal(api.assistantBridgeUrl('mac.tailnet.ts.net', 9000), 'ws://mac.tailnet.ts.net:9000');
  assert.equal(api.assistantBridgeUrl('wss://mac.tailnet.ts.net', 8790), 'wss://mac.tailnet.ts.net');
  assert.equal(api.assistantBridgeUrl('WS://10.0.0.2:1234/bridge', 8790), 'WS://10.0.0.2:1234/bridge');
  bridge.configure(options('100.64.0.7'));
  assert.equal(sockets[0].url, 'ws://100.64.0.7:8790');
  assert.equal(bridge.state().status, 'Connecting to 100.64.0.7:8790...');
  bridge.configure(options('wss://mac.tailnet.ts.net'));
  assert.equal(sockets[1].url, 'wss://mac.tailnet.ts.net');
  assert.equal(bridge.state().status, 'Connecting to wss://mac.tailnet.ts.net...');
});

test('the bridge authenticates on open, and a replaced connection\'s late events never touch its successor', () => {
  const { bridge, sockets, timeouts, options, runTimeouts } = bridgeEnv();
  bridge.configure(options('old-host'));
  const first = sockets[0];
  first.listener.onOpen();
  assert.deepEqual(plain(first.sent), [{ v: 1, chan: 'ctl', type: 'hello', version: 1, token: 'secret', deviceName: 'faceclaw', capabilities: ['chat', 'mcp'] }]);
  first.listener.onTextMessage(JSON.stringify({ v: 1, chan: 'ctl', type: 'hello-ack', serverName: 'openclaw' }));
  assert.deepEqual(plain(bridge.state()), { phase: 'connected', status: 'Connected to openclaw' });

  bridge.configure(options('new-host'));
  assert.equal(first.closed, true);
  const second = sockets[1];
  // The old socket reports its own close after the new one is already dialing.
  first.listener.onClosed(1000, 'bye');
  first.listener.onTextMessage(JSON.stringify({ v: 1, chan: 'ctl', type: 'hello-ack', serverName: 'stale' }));
  assert.equal(bridge.state().phase, 'connecting');
  assert.equal(timeouts.size, 0, 'no re-dial was scheduled for the socket that was replaced');
  second.listener.onOpen();
  assert.equal(second.sent[0].type, 'hello');

  // A lost connection re-dials once, even when a failure is followed by a close.
  second.listener.onFailure('reset');
  second.listener.onClosed(1006, '');
  assert.equal(bridge.state().phase, 'failed');
  assert.equal(timeouts.size, 1);
  runTimeouts();
  assert.equal(sockets.length, 3);
  assert.equal(sockets[2].url, 'ws://new-host:8790');

  bridge.stop();
  assert.equal(sockets[2].closed, true);
  sockets[2].listener.onClosed(1000, 'bye');
  assert.equal(bridge.state().phase, 'idle');
  assert.equal(timeouts.size, 0);
});

test('on iOS the bridge pings an open connection, which would otherwise time out idle; Android\'s socket pings by itself', () => {
  const ios = bridgeEnv({ ios: true });
  ios.bridge.configure(ios.options('host'));
  assert.equal(ios.intervals.size, 0, 'nothing to keep alive before the socket opens');
  ios.sockets[0].listener.onOpen();
  const [keepalive] = [...ios.intervals.values()];
  // FaceclawSocket.m gives a websocket 20 s without traffic.
  assert.ok(keepalive.ms < 20_000);
  keepalive.fn();
  const ping = ios.sockets[0].sent.at(-1);
  assert.equal(ping.chan, 'ctl'); assert.equal(ping.type, 'ping');
  // The bridge's pong needs no answer.
  ios.sockets[0].listener.onTextMessage(JSON.stringify({ v: 1, chan: 'ctl', type: 'pong', ts: ping.ts }));
  assert.equal(ios.sockets[0].sent.at(-1), ping);
  ios.sockets[0].listener.onFailure('timed out');
  assert.equal(ios.intervals.size, 0);
  ios.runTimeouts();
  ios.sockets[1].listener.onOpen();
  assert.equal(ios.intervals.size, 1);
  ios.bridge.stop();
  assert.equal(ios.intervals.size, 0);

  const android = bridgeEnv();
  android.bridge.configure(android.options('host'));
  android.sockets[0].listener.onOpen();
  assert.equal(android.intervals.size, 0);
});

test('the bridge connection follows the Assistant settings, re-dialing only when one of its own changes', () => {
  const values = { backend: 'direct', host: '', port: '8790', token: '', proactive: true };
  const calls = [];
  const setting = key => ({ get: () => values[key] });
  const api = loader({}, {
    '../ui/dashboard-settings': {
      assistantBackendSetting: setting('backend'), assistantBridgeHostSetting: setting('host'),
      assistantBridgePortSetting: setting('port'), assistantBridgeTokenSetting: setting('token'),
      assistantAllowProactiveSetting: setting('proactive'),
    },
    './bridge-client': { assistantBridge: {
      configure: options => calls.push({ ...options, allowProactive: options.allowProactive() }), stop: () => calls.push('stop'),
    } },
  })('app/assistant/bridge-sync.ts');

  api.syncAssistantBridge();
  assert.deepEqual(calls, ['stop'], 'an LLM called from the phone needs no bridge');
  Object.assign(values, { backend: 'external', host: ' 100.64.0.7 ' });
  api.syncAssistantBridge();
  assert.deepEqual(calls, ['stop', 'stop'], 'no token yet');
  values.token = 'secret';
  api.syncAssistantBridge();
  assert.deepEqual(plain(calls.at(-1)), { host: '100.64.0.7', port: 8790, token: 'secret', deviceName: 'faceclaw', allowProactive: true });
  // Some other setting changed.
  api.syncAssistantBridge(); api.syncAssistantBridge();
  assert.equal(calls.length, 3);
  values.port = 'nonsense';
  api.syncAssistantBridge();
  assert.equal(calls.length, 4); assert.equal(calls.at(-1).port, 8790);
  values.port = '9000';
  api.syncAssistantBridge();
  assert.equal(calls.at(-1).port, 9000);

  // iOS drops the connection with its runtime and dials again when that returns.
  api.stopAssistantBridge();
  assert.equal(calls.at(-1), 'stop');
  api.syncAssistantBridge();
  assert.equal(calls.at(-1).host, '100.64.0.7');
  values.backend = 'direct';
  api.syncAssistantBridge();
  assert.equal(calls.at(-1), 'stop');
});

/** The real settings over an in-memory store. */
function realSettings({ ios }) {
  const store = new Map();
  const sandbox = { exports: {}, global: { isIOS: ios, isAndroid: !ios }, setTimeout: fn => fn(),
    require: id => id.includes('settings-store') ? { onSettingsStoreChanged() {},
      getStringSetting: (key, fallback) => store.get(key) ?? fallback, setStringSetting: (key, value) => store.set(key, value),
      getBooleanSetting: (key, fallback) => store.get(key) ?? fallback, setBooleanSetting: (key, value) => store.set(key, value) }
      : id.includes('whisper-server-stt') ? { normalizeWhisperServerUrl: value => (/^https?:\/\/\S+$/.test(value.trim()) ? value.trim() : '') }
      : { Layer: class {}, ASSISTANT_MODEL_CHOICES: [] } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', 'app/ui/dashboard-settings.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, sandbox);
  return { settings: sandbox.exports, store };
}

test('Whisper server can be chosen before its URL is set, while the key-based providers still wait for their key', () => {
  for (const ios of [false, true]) {
    const { settings, store } = realSettings({ ios });
    const provider = settings.voiceProviderSetting;
    assert.equal(provider.isDisabled('whisper-server'), false);
    assert.equal(settings.isVoiceProviderSetUp('whisper-server'), false, 'Translate still asks for the URL');
    for (const keyed of ['elevenlabs', 'whisper', 'soniox']) {
      assert.equal(provider.isDisabled(keyed), true, keyed);
      assert.equal(settings.isVoiceProviderSetUp(keyed), false, keyed);
    }
    assert.equal(provider.isDisabled('onboard'), false);
    assert.equal(settings.isVoiceProviderSetUp('onboard'), true);
    assert.equal(provider.set('whisper-server'), 'whisper-server');
    assert.equal(provider.get(), 'whisper-server');
    assert.match(provider.description, /Whisper server[^.]*choosing it shows its settings below/);

    store.set('voice.whisperServerUrl', 'http://100.64.0.7:8004/v1');
    assert.equal(settings.isVoiceProviderSetUp('whisper-server'), true);
    store.set('voice.sonioxApiKey', 'key');
    assert.equal(provider.isDisabled('soniox'), false);
    assert.equal(settings.isVoiceProviderSetUp('soniox'), true);
  }
});

test('the assistant backend offers the agent bridge on iOS as on Android', () => {
  for (const ios of [false, true]) {
    const { settings } = realSettings({ ios });
    const backend = settings.assistantBackendSetting;
    assert.deepEqual([...backend.values], ['direct', 'external']);
    assert.equal(backend.set('external'), 'external');
    assert.equal(backend.get(), 'external');
    assert.match(backend.description, /OpenClaw/);
    assert.match(backend.description, ios ? /Apple Intelligence/ : /downloaded on-phone model/);
    assert.equal(/Transport Security/.test(settings.assistantBridgeHostSetting.description), ios);
  }
});
