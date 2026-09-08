const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { createHash } = require('node:crypto');
const { zstdCompressSync } = require('node:zlib');
const { loader } = require('./helpers/load-typescript.cjs');
const { LvglFont } = require('../.test-build/app/graphics/lvgl-font.js');

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

test('iOS LVGL reader loads the bundled font including CJK and game symbols', () => {
  const bytes = new Uint8Array(fs.readFileSync('app/fonts/source-han-sans/SourceHanSansSC-Light-20.lvgl.bin'));
  const font = new LvglFont(bytes);
  // Metrics and full glyph SHA-256 vectors from production Java LvglFontFile.
  assert.deepEqual([...font.metrics], [25, 19]);
  const vectors = [
    [0x25a6, 'b08ecb603fd059b0a00ba3088f18b79185c421e73049797cd3cb0828e1e5cd04'],
    [0x25c6, 'c176d5dcdb5f7e3a7220455528efde3760672c40cee39b422fc3f5ad20df66dd'],
    [0x4e2d, '9bde2c8f1ffcf7afc598f4d0350c9ff262484816aa0c9b46d31f0c3c09613003'],
    [0xff21, '0074f96299a75b86912282416e47e0823790e091352aec852eff49b89b2e719d'],
  ];
  for (const [cp, hash] of vectors) {
    const glyph = font.glyph(cp);
    const w = glyph[0] | glyph[1] << 8, h = glyph[2] | glyph[3] << 8;
    assert.ok(w > 0 && h > 0); assert.equal(glyph.length, 8 + (Math.floor(w / 2) + 1) * h);
    assert.equal(createHash('sha256').update(glyph).digest('hex'), hash);
  }
  assert.equal(font.glyph(0x10ffff).length, 0);
  assert.throws(() => new LvglFont(bytes.subarray(0, 80)), /bounds|Truncated/);
});

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
  let browserOptions, actions, opened;
  const load = loader({ global: { isIOS: true } }, {
    '../../native/file-access': {}, '../../native/font-files': { isFontFile: () => false },
    '../../graphics/installed-fonts': {}, '../../native/image-files': { isDecodableImageFile: () => false },
    '../evenhub/installed-apps': { readEvenHubPackageManifest: () => null }, '../evenhub/permission-dialog': {},
    './file-browser': { FileBrowserLayer: class { constructor(options) { browserOptions = options; } } },
    './file-info-dialog': { FileInfoDialogLayer: class { constructor(entry, value) { actions = value; } } },
    './font-previewer': {}, './image-viewer': {}, './text-viewer': {},
    '../../ui/shell/in-process-window': { createInProcessWindow: () => ({}) }, '../../ui/shell/shell': {},
  });
  load('app/apps/files/files-app.ts').createFilesAppWindow({ openEhpkApp: path => { opened = path; } });
  assert.equal(browserOptions.isSupportedFile('test.EHPK'), true);
  const ctx = { stack: { push() {}, pop() {} } };
  browserOptions.onFilePicked({ name: 'test.ehpk', path: '/Documents/test.ehpk' }, ctx);
  assert.deepEqual(Array.from(actions, a => a.label), ['Run app']);
  actions[0].onSelect(ctx); assert.equal(opened, '/Documents/test.ehpk');
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
    '../../ui/shell/shell': {}, './installed-apps': {},
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

function sessionHarness() {
  const settings = new Map(), logs = [], renders = [];
  const load = loader({ global: { isIOS: true }, setTimeout, clearTimeout, Promise }, {
    '@nativescript/core': { ApplicationSettings: { getString: (k, d) => settings.get(k) ?? d, setString: (k, v) => settings.set(k, v) } },
    'upng-js': require('upng-js'),
    '../../graphics/evenhub-font': { EvenHubFont: { get: () => ({ drawText() {}, drawTextWrapped() {}, lineHeight: 20 }) } },
    '../../ui/dashboard-settings': {}, '../../ui/sound-effects': {}, './api-key-dialog': {},
    './mic-router': { evenHubMicRouter: {} }, './imu-router': { evenHubImuRouter: {} },
    './compass-router': { evenHubCompassRouter: {} }, '../../assistant/tool-registry': {},
    '../../native/location': {}, '../../native/location-tracker': {}, '../../g2/android-permissions': {},
  });
  const api = load('app/apps/evenhub/session.ts');
  const session = new api.EvenHubSession({ name: 'Probe', packageId: 'test.probe', permissions: [] }, '/test/dist', line => logs.push(line));
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
  const native = { startEntrypointScript: (...args) => calls.push(args), destroy: () => calls.push('destroy') };
  const load = loader({ FaceclawEvenHubWebView: { new: () => native },
    setTimeout: fn => { timers.set(1, fn); return 1; }, clearTimeout: id => timers.delete(id) }, {
    './session': { EVENHUB_BRIDGE_INJECT_SCRIPT: 'BRIDGE', buildFaceclawExtensionsScript: () => 'EXT' }, '../../version': { FACECLAW_VERSION: 'test' },
  });
  const { createEvenHubWebView } = load('app/apps/evenhub/webview.ios.ts');
  const session = { manifest: { name: 'Probe', entrypoint: 'index.html' }, distDir: '/app/dist' };
  const host = createEvenHubWebView(session); assert.equal(calls.length, 0);
  timers.get(1)(); assert.equal(calls[0][0], '/app/dist'); assert.match(calls[0][2], /postMessage/); assert.match(calls[0][2], /BRIDGEEXT$/);
  host.destroy(); assert.equal(timers.size, 0); assert.equal(calls.at(-1), 'destroy');
  assert.throws(() => createEvenHubWebView({ ...session, remoteUrl: 'https://example.test' }), /local/);
});
