const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { zstdCompressSync } = require('node:zlib');
const { loader } = require('./helpers/load-typescript.cjs');

function pack(files) {
  const key = Buffer.from('EVEN REALITIES');
  const xor = b => Buffer.from(b.map((v, i) => v ^ key[i % key.length]));
  const header = Buffer.alloc(20); header.write('EHPK'); header.writeUInt32LE(20, 8);
  return Buffer.concat([header, ...Object.entries(files).map(([name, value]) => {
    const text = Buffer.from(value), body = zstdCompressSync(text), path = Buffer.from(name), record = Buffer.alloc(16);
    record.writeUInt32LE(0xbaa9bae4); record.writeUInt32LE(body.length, 4); record.writeUInt32LE(text.length, 8); record.writeUInt16LE(path.length, 14);
    return Buffer.concat([record, xor(path), xor(body)]);
  })]);
}

test('EHPK entrypoints and extraction paths cannot escape their package directory', () => {
  const load = loader({}, { fzstd: require('fzstd') });
  const api = load('app/apps/evenhub/ehpk.ts');
  assert.equal(api.safeEhpkPath('dist/assets/game.js'), true);
  for (const path of ['../settings.json', '/private/file', 'dist/../../file', 'dist\\file', 'dist//x', '.', '..', 'x\0y', 'https://host/app']) {
    assert.equal(api.safeEhpkPath(path), false);
    assert.throws(() => api.parseManifest(JSON.stringify({ entrypoint: path })), /entrypoint/);
    assert.throws(() => api.parseEhpk(pack({ [path]: 'test' })), /invalid file path/);
  }
  const archive = api.parseEhpk(pack({ 'app.json': '{"package_id":"test.app"}', 'dist/index.html': '<html>test</html>' }));
  assert.ok(archive.files.has('dist/index.html'));
});

test('Files on iOS exposes Run app for EHPKs and passes the selected local path', () => {
  let browserOptions, actions, opened, installed;
  const load = loader({ global: { isIOS: true } }, {
    '../../native/file-access': {}, '../../native/font-files': { isFontFile: () => false },
    '../../graphics/installed-fonts': {}, '../../native/image-files': { isDecodableImageFile: () => false },
    '../../native/video-player': { isPlayableVideoFile: () => true },
    '../evenhub/installed-apps': { readEvenHubPackageManifest: () => null }, '../evenhub/permission-dialog': {},
    './file-browser': { FileBrowserLayer: class { constructor(options) { browserOptions = options; } } },
    './file-info-dialog': { FileInfoDialogLayer: class { constructor(entry, value) { actions = value; } } },
    './font-previewer': {}, './image-viewer': {}, './text-viewer': {},
    '../../ui/shell/in-process-window': { createInProcessWindow: () => ({}) }, '../../ui/shell/shell': {},
  });
  load('app/apps/files/files-app.ts').createFilesAppWindow({ openEhpkApp: path => { opened = path; }, installEhpkApp: path => { installed = path; } });
  assert.equal(browserOptions.isSupportedFile('test.EHPK'), true);
  // Video playback is Android-only for now.
  assert.equal(browserOptions.isSupportedFile('clip.mp4'), false);
  const ctx = { stack: { push() {}, pop() {} } };
  browserOptions.onFilePicked({ name: 'test.ehpk', path: '/Documents/test.ehpk' }, ctx);
  assert.deepEqual(Array.from(actions, a => a.label), ['Run app', 'Install']);
  actions[0].onSelect(ctx); assert.equal(opened, '/Documents/test.ehpk');
  actions[1].onSelect(ctx); assert.equal(installed, '/Documents/test.ehpk');
});

test('local package runtimes unpack independently and clean up after closing or a failed launch', async () => {
  const files = new Map(), sessions = [];
  const manifest = { package_id: 'test.app', name: 'Test' };
  let archive = pack({ 'app.json': JSON.stringify(manifest), 'dist/index.html': '<html>test</html>' });
  class Session { constructor(manifest, distDir) { this.manifest = manifest; this.distDir = distDir; sessions.push(this); } attachWebView(handle) { this.handle = handle; } close() { this.handle.destroy(); } }
  const load = loader({ global: { isIOS: true } }, {
    '@nativescript/core': { Application: {} }, fzstd: require('fzstd'),
    '../../native/file-access': { appFilesDirPath: () => '/private/app', readBinaryFile: () => archive,
      writeBinaryFile: (path, bytes) => { files.set(path, bytes); return true; },
      deletePathRecursively: path => { for (const key of files.keys()) if (key.startsWith(path + '/')) files.delete(key); } },
    './session': { EvenHubSession: Session }, './evenhub-window': { createEvenHubWindow: () => ({}) },
    './webview': { createEvenHubWebView: () => ({ evaluateJs() {}, destroy() {} }) },
    '../../ui/shell/shell': {}, './installed-apps': { readEvenHubPackageManifest: () => ({ packageId: 'test.app' }) },
  });
  const manager = load('app/apps/evenhub/manager.ts'), ctx = { appendLog() {}, launchInProcessApp: async () => {} };
  await manager.launchPackage(ctx, '/test.ehpk'); await manager.launchPackage(ctx, '/test.ehpk');
  assert.notEqual(sessions[0].distDir, sessions[1].distDir); assert.equal(manager.runningAppCount(), 2);
  sessions[0].close(); assert.equal(manager.runningAppCount(), 1);
  assert.ok(files.has(sessions[1].distDir + '/index.html')); assert.ok(!files.has(sessions[0].distDir + '/index.html'));
  sessions[1].close(); assert.equal(files.size, 0);
  await assert.rejects(manager.launchPackage({ ...ctx, launchInProcessApp: async () => { throw new Error('test launch failed'); } }, '/test.ehpk'), /test launch failed/);
  assert.equal(files.size, 0); assert.equal(manager.runningAppCount(), 0);
  archive = pack({ 'app.json': JSON.stringify(manifest) });
  await assert.rejects(manager.launchPackage(ctx, '/bad.ehpk'), /entrypoint is missing/);
  assert.equal(files.size, 0);
});

function sessionHarness(overrides = {}, playBuzzer = () => {}, { packageId = 'test.probe', settings = new Map() } = {}) {
  const logs = [], renders = [];
  const load = loader({ global: { isIOS: true }, setTimeout, clearTimeout, Promise }, {
    '@nativescript/core': { ApplicationSettings: { getString: (k, d) => settings.get(k) ?? d, setString: (k, v) => settings.set(k, v) } },
    'upng-js': require('upng-js'),
    '../../graphics/evenhub-font': { EvenHubFont: { get: () => ({ drawText() {}, drawTextWrapped() {}, lineHeight: 20 }) } },
    '../../ui/dashboard-settings': {}, '../../ui/sound-effects': {}, './api-key-dialog': {},
    './mic-router': { evenHubMicRouter: {} }, './imu-router': { evenHubImuRouter: {} },
    './compass-router': { evenHubCompassRouter: {} }, '../../assistant/tool-registry': {},
    '../../native/location': {}, '../../native/location-tracker': {}, '../../native/location-permissions': {}, ...overrides,
  });
  const api = load('app/apps/evenhub/session.ts');
  const session = new api.EvenHubSession({ name: 'Probe', packageId, permissions: [] }, '/test/dist', line => logs.push(line), '', playBuzzer);
  session.attachWindow({ requestRender: () => renders.push(1), windowId: 'probe', closeWindow() {} });
  const web = vm.createContext({ Promise, Map, Date, console });
  web.window = web;
  web.__faceclawEvenHub = { postMessage: (name, args, id) => session.handleBridgeCall(name, args, id) };
  let destroyed = false;
  session.attachWebView({ evaluateJs: script => vm.runInContext(script, web), destroy: () => { destroyed = true; } });
  vm.runInContext(api.EVENHUB_BRIDGE_INJECT_SCRIPT, web);
  const call = (method, data = {}) => web.flutter_inappwebview.callHandler('evenAppMessage', JSON.stringify({ method, data }));
  return { session, call, web, logs, renders, destroyed: () => destroyed };
}

test('injected EvenHub RPC creates, updates and composites an image page with no Android globals', async () => {
  const h = sessionHarness();
  assert.equal(await h.call('createStartUpPageContainer', { containerTotalNum: 1,
    imageObject: [{ containerID: 1, containerName: 'board', xPosition: 0, yPosition: 0, width: 2, height: 2 }] }), 0);
  assert.equal(await h.call('updateImageRawData', { containerID: 1, containerName: 'board', imageData: [0, 80, 160, 255] }), 0);
  const painted = h.session.paint({ width: 576, height: 288 }, true);
  assert.deepEqual([painted.pixels[0], painted.pixels[1], painted.pixels[576], painted.pixels[577]], [0, 80, 160, 255]);
  assert.equal(await h.call('setLocalStorage', { key: 'score', value: '42' }), true);
  assert.equal(await h.call('getLocalStorage', { key: 'score' }), '42');
  const events = [];
  h.web._listenEvenAppMessage = value => events.push(typeof value === 'string' ? JSON.parse(value) : value);
  h.session.handleGesture({ type: 'click', source: 'ring' });
  assert.ok(events.some(e => e.method === 'evenHubEvent'));
  assert.equal(await h.call('audioControl', { isOpen: true }), false);
  assert.equal(await h.call('imuControl', { isOpen: true }), false);
  assert.equal(await h.call('getAppLocation'), null);
  h.session.close(); await new Promise(resolve => setTimeout(resolve, 120)); assert.equal(h.destroyed(), true);
});

test('iOS webview adapter defers loading until handles attach and destroys a not-yet-loaded app', () => {
  const timers = new Map(), calls = [];
  const native = { startEntrypointScript: (...args) => calls.push(args), startURLScript: (...args) => calls.push(args), destroy: () => calls.push('destroy') };
  const load = loader({ FaceclawEvenHubWebView: { new: () => native },
    setTimeout: fn => { timers.set(1, fn); return 1; }, clearTimeout: id => timers.delete(id) }, {
    './session': { EVENHUB_BRIDGE_INJECT_SCRIPT: 'BRIDGE', buildFaceclawExtensionsScript: () => 'EXT' }, '../../version': { FACECLAW_VERSION: 'test' },
  });
  const { createEvenHubWebView } = load('app/apps/evenhub/webview.ios.ts');
  const session = { manifest: { name: 'Probe', entrypoint: 'index.html' }, distDir: '/app/dist' };
  const host = createEvenHubWebView(session); assert.equal(calls.length, 0);
  timers.get(1)(); assert.equal(calls[0][0], '/app/dist'); assert.match(calls[0][2], /postMessage/); assert.match(calls[0][2], /BRIDGEEXT$/);
  host.destroy(); assert.equal(timers.size, 0); assert.equal(calls.at(-1), 'destroy');
  const remote = createEvenHubWebView({ ...session, remoteUrl: 'https://example.test' });
  timers.get(1)(); assert.equal(calls.at(-1)[0], 'https://example.test');
  remote.destroy();
});

test('iOS webview adapter passes fatal errors through and logs host notices', () => {
  const native = {}, failures = [], logs = [];
  const load = loader({ FaceclawEvenHubWebView: { new: () => native }, setTimeout: () => 1, clearTimeout() {},
    console: { log: line => logs.push(line), warn() {} } }, {
    './session': { EVENHUB_BRIDGE_INJECT_SCRIPT: '', buildFaceclawExtensionsScript: () => '' }, '../../version': { FACECLAW_VERSION: 'test' },
  });
  load('app/apps/evenhub/webview.ios.ts').createEvenHubWebView({ manifest: { name: 'Probe' },
    webViewFailed: (message, fatal) => failures.push([message, fatal]) });
  native.eventHandler(JSON.stringify({ kind: 'error', message: 'offline' }));
  native.eventHandler(JSON.stringify({ kind: 'error', message: 'crashed', fatal: true }));
  native.eventHandler(JSON.stringify({ kind: 'notice', message: 'Blocked navigation to a mailto: URL.' }));
  assert.deepEqual(failures, [['offline', false], ['crashed', true]]);
  assert.deepEqual(logs, ['[evenhub:Probe] Blocked navigation to a mailto: URL.']);
});

test('EvenHub load errors replace the window only before the app loads, and a later load clears them', () => {
  const drawn = [];
  const h = sessionHarness({ '../../graphics/evenhub-font': { EvenHubFont: { get: () => ({
    drawText: (_image, _x, _y, text) => drawn.push(text), drawTextWrapped() {}, lineHeight: 20 }) } } });
  const heading = () => { drawn.length = 0; h.session.paint({ width: 576, height: 288 }, true); return drawn[0]; };
  h.session.webViewFailed('offline');
  assert.equal(heading(), 'Could not run Probe...');
  h.session.webViewLoaded();
  assert.equal(heading(), 'Loading Probe...');
  // A failed navigation after the first load leaves the app's page running.
  h.session.webViewFailed('A server with the specified hostname could not be found.');
  assert.equal(heading(), 'Loading Probe...');
  assert.ok(h.logs.includes('evenhub: A server with the specified hostname could not be found.'));
  h.session.webViewFailed('The app\'s web process ended.', true);
  assert.equal(heading(), 'Could not run Probe...');
  h.session.close();
});

test('SDK storage is partitioned by package, even for package IDs containing the key separator', async () => {
  const settings = new Map();
  const [plain, colon, percent] = ['a', 'a:ls:b', 'a%3Als%3Ab'].map(packageId => sessionHarness({}, undefined, { packageId, settings }));
  assert.equal(await colon.call('setLocalStorage', { key: 'c', value: 'secret' }), true);
  assert.equal(await colon.call('getLocalStorage', { key: 'c' }), 'secret');
  assert.equal(await plain.call('getLocalStorage', { key: 'b:ls:c' }), '');
  assert.equal(await percent.call('getLocalStorage', { key: 'c' }), '');
  // Ordinary package IDs keep their existing keys.
  assert.equal(await plain.call('setLocalStorage', { key: 'k', value: 'v' }), true);
  assert.equal(settings.get('evenhub:a:ls:k'), 'v');
  for (const h of [plain, colon, percent]) h.session.close();
});

test('EvenHub location uses the platform boundary and closes its subscription', async () => {
  let permission = true, callback, starts = 0, stops = 0;
  const fix = { latitude: 12, longitude: 34, accuracyMeters: 5, timestampMs: 1234 };
  const h = sessionHarness({
    '../../native/location-permissions': { ensureFineLocationPermission: async () => permission },
    '../../native/location': { getCurrentLocation: async () => fix },
    '../../native/location-tracker': { LocationTracker: class {
      constructor(value) { callback = value; } start() { starts++; } stop() { stops++; }
    } },
  });
  assert.equal(await h.call('getAppLocation'), null); // No manifest permission.
  h.session.manifest.permissions.push({ name: 'location' });
  assert.deepEqual(JSON.parse(JSON.stringify(await h.call('getAppLocation'))), {
    latitude: 12, longitude: 34, accuracy: 5, timestamp: 1234,
  });
  permission = false;
  assert.equal(await h.call('startAppLocationUpdates'), false);
  permission = true;
  assert.equal(await h.call('startAppLocationUpdates'), true);
  assert.equal(starts, 1);
  const events = [];
  h.web._listenEvenAppMessage = value => events.push(typeof value === 'string' ? JSON.parse(value) : value);
  callback.onLocation(fix);
  assert.equal(events.at(-1).method, 'appLocationChanged');
  h.session.close();
  assert.equal(stops, 1);
});

test('iOS store terminal identity persists and signing crosses the native boundary', () => {
  const settings = new Map();
  const api = loader({ NSUUID: { UUID: () => ({ UUIDString: '12345678-1234-5678-90AB-123456789ABC' }) },
    FaceclawCrypto: { hmacSha256Message: (key, body) => require('node:crypto').createHmac('sha256', key).update(body).digest('base64') },
  }, { '../../native/settings-store': {
    getStringSetting: (key, fallback) => settings.get(key) ?? fallback,
    setStringSetting: (key, value) => settings.set(key, value),
  } })('app/apps/evenhub/even-platform.ios.ts');
  assert.equal(api.getPhoneOpenUdid(), '1234567812345678');
  assert.equal(api.getPhoneOpenUdid(), '1234567812345678');
  assert.equal(settings.size, 1);
  assert.equal(api.hmacSha256Base64('key', 'The quick brown fox jumps over the lazy dog'), '97yD9DBThCSxMpjmqm+xQ+9NWaFJRhdZl0edvC0aPNg=');
});

test('store login and catalog requests use platform signing with the shared wire format', async () => {
  const requests = [], signatures = [];
  let token = '';
  const api = loader({ setTimeout, clearTimeout }, {
    './even-platform': { getPhoneOpenUdid: () => 'fixture-terminal', hmacSha256Base64: (_key, value) => { signatures.push(value); return 'fixture-signature'; } },
    './credentials': { getEvenHubToken: () => token, hasEvenHubCredentials: () => !!token,
      saveEvenHubSession: (_email, value) => { token = value; }, invalidateEvenHubToken() {} },
    '../../util/http': { fetchWithUserAgent: async (url, init) => {
      requests.push({ url, ...init });
      return { status: 200, json: async () => ({ code: 0, data: url.endsWith('/login') ? { token: 'fixture-token' } : { list: [], total: 0 } }) };
    } },
  })('app/apps/evenhub/even-api.ts');
  await api.evenHubApi.signIn('test@example.invalid', 'fixture-password', false);
  await api.evenHubApi.listApps();
  assert.equal(requests.length, 2);
  assert.match(requests[0].headers.common, /openUdid=fixture-terminal/);
  assert.equal(requests[1].headers.token, 'fixture-token');
  assert.equal(requests[1].headers.sign, 'fixture-signature');
  assert.equal(signatures[0], api.signingParts('POST', '/v2/g/login', requests[0].headers.common, '', '', requests[0].body));
});


test('EvenHub buzzer RPC uses the host action on iOS and chunks and paces long sequences', async () => {
  const sounds = loader()('app/ui/sound-effects.ts'), played = [];
  const h = sessionHarness({ '../../ui/sound-effects': sounds }, bytes => played.push([...bytes]));
  const steps = Array.from({ length: 49 }, () => ({ freq: 3000, ms: 1, duty: 25 }));
  await h.session.dispatchExtension('playBuzzer', [steps]);
  assert.equal(played.length, 2);
  assert.deepEqual(played[0], [...sounds.buildSoundSequencePayload(steps.slice(0, 48))]);
  assert.deepEqual(played[1], [...sounds.buildSoundSequencePayload(steps.slice(48))]);
  await h.session.dispatchExtension('playBuzzer', [[null, { freq: 'bad', ms: 10 }]]);
  assert.equal(played.length, 2);
  h.session.close();
});

test('EvenHub buzzer RPC rejects the app promise when sending fails', async () => {
  const sounds = loader()('app/ui/sound-effects.ts');
  const h = sessionHarness({ '../../ui/sound-effects': sounds }, () => Promise.reject(new Error('link lost')));
  await assert.rejects(h.session.dispatchExtension('playBuzzer', [[{ freq: 880, ms: 50 }]]), /link lost/);
  h.session.close();
});

test('EvenHub assistant tools skip malformed names and schemas with a warning in the app console', () => {
  const offered = [];
  const h = sessionHarness({ '../../assistant/tool-registry': { toolRegistry: { setAppTools: provider => offered.push(provider), removeAppTools() {} } } });
  const warnings = [];
  h.web.console = { warn: message => warnings.push(message) };
  const object = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] };
  h.session.dispatchExtension('setAssistantTools', [[
    { name: 'ok', description: 'fine', parameters: object },
    { name: 'no_params', description: 'defaults' },
    { name: 'has space', parameters: object },
    { name: 'x'.repeat(65), parameters: object },
    { name: 'untyped', parameters: { properties: {} } },
    { name: 'string', parameters: { type: 'string' } },
    { name: 'union', parameters: { type: 'object', anyOf: [object] } },
    { name: 'bad_props', parameters: { type: 'object', properties: [] } },
    { name: 'bad_required', parameters: { type: 'object', required: 'n' } },
  ]]);
  // Through JSON: the default schema is built in the session's realm.
  assert.deepEqual(JSON.parse(JSON.stringify(offered[0].specs.map(spec => [spec.name, spec.inputSchema]))), [
    ['ok', object],
    ['no_params', { type: 'object', properties: {} }],
  ]);
  assert.equal(warnings.length, 7);
  assert.ok(warnings.every(message => message.startsWith('Faceclaw: setAssistantTools: skipped tool')));
  assert.match(warnings[0], /"has space": name must be/);
  assert.match(warnings[2], /"untyped": parameters must be a JSON Schema with type "object"/);
  assert.match(warnings[4], /"union": parameters can't use oneOf, anyOf or allOf/);
  h.session.close();
});

test('iOS binary downloads copy out of the response NSData, which bufferFromData does not retain', async () => {
  const native = new Uint8Array([0x45, 0x48, 0x50, 0x4b, 1, 2, 3]);
  const { downloadBinary } = loader({}, {
    '@nativescript/core': { Http: { request: async () => ({ statusCode: 200, headers: {}, content: { toArrayBuffer: () => native.buffer } }) } },
    '../util/http': { withUserAgent: headers => headers ?? {} },
  })('app/native/binary-http.ios.ts');
  const { bytes } = await downloadBinary('https://cdn.example/app.ehpk', 1000);
  native.fill(0); // The released NSData's pages are reused or zeroed.
  assert.deepEqual(Array.from(bytes), [0x45, 0x48, 0x50, 0x4b, 1, 2, 3]);
});

test('zeroed installed packages are discarded with their registry entry kept; real packages are left alone', () => {
  const files = new Map(), deleted = [];
  const installed = loader({}, {
    fzstd: require('fzstd'),
    '../../native/file-access': { readBinaryFile: path => files.get(path) ?? null, readTextFile() {}, writeBinaryFile() {},
      appFilesDirPath: () => '/app', deletePathRecursively: path => { deleted.push(path); files.delete(path); } },
    '../../native/settings-store': { getStringSetting: (_key, fallback) => fallback, setStringSetting() {} },
    '../../native/icon-image': {}, '../../graphics/icons': {}, '../../graphics/image': {},
  })('app/apps/evenhub/installed-apps.ts');
  const path = installed.installedEvenHubPackagePath('test.app');
  files.set(path, pack({ 'app.json': '{"package_id":"test.app"}' }));
  assert.equal(installed.discardZeroedEvenHubPackage('test.app'), false);
  files.set(path, new Uint8Array([...new Uint8Array(1000), 1]));
  assert.equal(installed.discardZeroedEvenHubPackage('test.app'), false);
  assert.equal(installed.discardZeroedEvenHubPackage('missing.app'), false);
  assert.deepEqual(deleted, []);
  files.set(path, new Uint8Array(4096));
  assert.equal(installed.discardZeroedEvenHubPackage('test.app'), true);
  assert.deepEqual(deleted, [path], 'only the EHPK goes; the icon and registry entry stay for Reinstall');
});
