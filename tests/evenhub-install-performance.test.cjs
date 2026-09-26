const test = require('node:test');
const assert = require('node:assert/strict');
const { zstdCompressSync } = require('node:zlib');
const { loader } = require('./helpers/load-typescript.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));
function pack(files) {
  const key = Buffer.from('EVEN REALITIES'), xor = b => Buffer.from(b.map((v, i) => v ^ key[i % key.length]));
  const header = Buffer.alloc(20); header.write('EHPK'); header.writeUInt32LE(20, 8);
  return Buffer.concat([header, ...Object.entries(files).map(([name, value]) => {
    const raw = Buffer.from(value), body = zstdCompressSync(raw), path = Buffer.from(name), h = Buffer.alloc(16);
    h.writeUInt32LE(0xbaa9bae4); h.writeUInt32LE(body.length, 4); h.writeUInt32LE(raw.length, 8); h.writeUInt16LE(path.length, 14);
    return Buffer.concat([h, xor(path), xor(body)]);
  })]);
}
function packageFixture() {
  const expanded = [], files = new Map(), settings = new Map();
  const bytes = pack({ 'app.json': JSON.stringify({ package_id: 'test.large', name: 'Large', permissions: [{ name: 'network' }] }),
    'dist/index.html': '<html>Test</html>', 'dist/icon.svg': '<svg/>', 'dist/engine.wasm': 'abcdef'.repeat(2_000_000) });
  const load = loader({ global: { isIOS: true } }, {
    fzstd: { decompress: (input, output) => { expanded.push(output.length); return require('fzstd').decompress(input, output); } },
    '../../native/file-access': { readBinaryFile: path => files.get(path) ?? null, readTextFile() {}, appFilesDirPath: () => '/app',
      writeBinaryFile: (path, bytes) => { files.set(path, bytes); return true; },
      deletePathRecursively: path => { for (const key of files.keys()) if (key.startsWith(path + '/')) files.delete(key); } },
    '../../native/settings-store': { getStringSetting: (key, fallback) => settings.get(key) ?? fallback, setStringSetting: (key, value) => settings.set(key, value) },
    '../../native/icon-image': {}, '../../graphics/icons': {}, '../../graphics/image': {},
  });
  files.set('/source.ehpk', bytes);
  return { load, bytes, expanded, files };
}

test('permission inspection and installation never decompress the large app engine; extraction expands it once', () => {
  const h = packageFixture(), installed = h.load('app/apps/evenhub/installed-apps.ts');
  assert.equal(installed.readEvenHubPackageManifestBytes(h.bytes).packageId, 'test.large');
  assert.equal(h.expanded.length, 1);
  installed.installEvenHubPackageBytes(h.bytes);
  assert.ok(h.expanded.every(size => size < 1024), 'Only manifest, HTML and icon are needed to install');
  h.load('app/apps/evenhub/package-extraction.ts').extractPackage('/source.ehpk', '/runtime');
  assert.equal(h.expanded.filter(size => size === 12_000_000).length, 1);
  assert.equal(h.files.get('/runtime/dist/engine.wasm').length, 12_000_000);
});

test('store install releases serialized input before download and permission approval finish', async () => {
  let completeDownload, dialog, installed = false, launched = false;
  const download = new Promise(resolve => { completeDownload = resolve; });
  const manifest = { name: 'Test', packageId: 'test', permissions: [{ name: 'network' }], privacyPolicyUrl: '' };
  const load = loader({}, {
    '../../graphics/ui-fonts': {}, '../../graphics/image': {}, '../../graphics/textwrap': {}, '../../ui/menu-core': require('../.test-build/app/ui/menu-core.js'), '../files/text-viewer': {}, '../../ui/metrics': {},
    './even-api': { evenHubApi: { getStoreAppDetail: async () => null, downloadApp: () => download } },
    './installed-apps': { getInstalledEvenHubApp: () => null, readEvenHubPackageManifestBytes: () => manifest,
      readEvenHubPackageManifest: () => null, installedEvenHubPackagePath: () => '', installedEvenHubAppId: id => id,
      installEvenHubPackageBytes: () => { installed = true; return { packageId: 'test', version: '1' }; } },
    './manager': { closeRunningPackage() {} }, './updates': {},
    './permission-dialog': { EvenHubPermissionDialogLayer: class {
      constructor(_name, _permissions, _policy, allow) { this.allow = allow; }
      handleInput() { this.allow(); }
    } },
  });
  const { EvenHubStoreDetailLayer } = load('app/apps/evenhub/store-detail-layer.ts');
  const layer = new EvenHubStoreDetailLayer({ packageId: 'test', name: 'Test' }, { appendLog() {}, launchApp: () => { launched = true; } });
  const ctx = { actions: { requestRender() {} }, stack: { push: value => { dialog = value; } } };
  let queue = Promise.resolve(), returned = false;
  queue = queue.then(() => layer.handleInput({ type: 'click' }, ctx)).then(() => { returned = true; });
  await flush(); assert.equal(returned, true, 'Input must return even while download is unresolved');
  completeDownload({ bytes: new Uint8Array(20), privacyPolicyUrl: '' });
  await flush(); assert.ok(dialog); assert.equal(installed, false);
  queue = queue.then(() => dialog.handleInput({ type: 'click' }, ctx));
  await queue; await flush();
  assert.equal(installed, true); assert.equal(launched, true);
});

test('iOS extraction sends paths to a worker, leaves main responsive, and terminates on success or failure', async () => {
  const workers = [], timers = new Map(); let serial = 0;
  class Worker {
    constructor() { workers.push(this); } postMessage(value) { this.request = value; } terminate() { this.terminated = true; }
  }
  const { unpackRuntime } = loader({ Worker, setTimeout: fn => { timers.set(++serial, fn); return serial; }, clearTimeout: id => timers.delete(id) })('app/apps/evenhub/unpack-runtime.ios.ts');
  const work = unpackRuntime('/source.ehpk', '/runtime');
  assert.deepEqual(JSON.parse(JSON.stringify(workers[0].request)), { path: '/source.ehpk', directory: '/runtime' });
  await flush(); // The JS loop remains runnable while extraction is outstanding.
  workers[0].onmessage({ data: { manifest: { packageId: 'test' } } });
  assert.equal((await work).packageId, 'test'); assert.equal(workers[0].terminated, true); assert.equal(timers.size, 0);
  const failed = unpackRuntime('/bad.ehpk', '/runtime');
  workers[1].onerror({ message: 'fixture failure' });
  await assert.rejects(failed, /fixture failure/); assert.equal(workers[1].terminated, true);
});

test('installed raster icons use the iOS decoder and retain decoded dimensions', () => {
  const calls = [];
  const iconLoader = loader({ global: { isIOS: true }, FaceclawGraphics: {
    decodeImageFileMaxWidthMaxHeight: (path, width, height) => {
      calls.push({ path, width, height });
      return path.endsWith('missing.png') ? null : new Uint8Array([2, 0, 1, 0, 80, 255]);
    },
  } }, { './kotlin-data': { fromData: data => data } })('app/native/icon-image.ios.ts');
  const installed = loader({}, {
    '../../native/icon-image': iconLoader,
    '../../native/file-access': { appFilesDirPath: () => '/app' },
    '../../native/settings-store': {}, '../../graphics/icons': {}, fzstd: require('fzstd'),
  })('app/apps/evenhub/installed-apps.ts');
  const record = { packageId: 'test', installedAt: 'today', iconFile: 'icon.png' };
  const image = installed.renderInstalledEvenHubIcon('test', 32, record);
  assert.equal(image.width, 2); assert.equal(image.height, 1);
  assert.deepEqual([...image.pixels], [80, 255]);
  assert.equal(calls[0].path, '/app/evenhub-installed/test/icon.png');
  assert.equal(calls[0].width, 32);
  assert.equal(installed.renderInstalledEvenHubIcon('test', 32, record), image);
  assert.equal(calls.length, 1);
  assert.equal(iconLoader.loadIconImage('/missing.png', 32, 32), null);
});
