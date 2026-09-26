const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
function load(file, modules = {}, globals = {}) {
  const context = { exports: {}, require: name => modules[name] ?? {}, ...globals };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return context.exports;
}
function scanner() {
  const instances = [];
  const api = load('app/native/qr-scan.ios.ts', {}, { FaceclawQrScanner: {
    isAvailable: () => true,
    new: () => {
      const native = { startWithCompletion(done) { this.done = done; }, cancel() { this.cancelled = true; this.done(null, null); } };
      instances.push(native); return native;
    },
  } });
  return { api, instances };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function layerFixture() {
  const { api, instances } = scanner();
  let available = true, pops = 0, renders = 0, launch = async () => {};
  const saved = [], launched = [], logs = [];
  const manager = load('app/apps/evenhub/manager.ts');
  const { LoadAppFromQrLayer } = load('app/apps/developer/load-app.ts', {
    '../../native/qr-scan': { ...api, isQrScannerAvailable: () => available },
    '../../ui/dashboard-settings': { developerAppUrlSetting: { set: url => saved.push(url) } },
    '../evenhub': { isLoadableAppUrl: url => manager.normalizeAppUrl(url) !== null,
      openEvenHubUrl: async (_ctx, url) => { launched.push(url); await launch(); } },
  }, { global: { isIOS: true } });
  const layer = new LoadAppFromQrLayer({ appendLog: text => logs.push(text) });
  const ctx = { actions: { requestRender: () => renders++ }, stack: { pop: () => { pops++; layer.onRemoved(); } } };
  return { layer, ctx, instances, saved, launched, logs, get pops() { return pops; }, get renders() { return renders; },
    available: value => { available = value; }, launch: fn => { launch = fn; } };
}

test('iOS scanner delivers one result, prevents overlapping cameras, and allows a later scan', async () => {
  const { api, instances } = scanner();
  assert.equal(api.isQrScannerAvailable(), true);
  const first = api.scanQrCode();
  await assert.rejects(api.scanQrCode(), /already open/);
  instances[0].done('https://example.com/app', null);
  instances[0].done('https://late.example/app', null);
  assert.equal(await first, 'https://example.com/app');
  const second = api.scanQrCode(); api.cancelQrScan();
  assert.equal(await second, null); assert.equal(instances[1].cancelled, true);
});

test('iOS scanner reports permission/native errors and releases its active scan', async () => {
  const { api, instances } = scanner();
  const first = api.scanQrCode(); instances[0].done(null, 'Allow Camera in Settings');
  await assert.rejects(first, /Allow Camera/);
  const retry = api.scanQrCode(); instances[1].done('http://dev.local:5173/?key=a%2Fb#app', null);
  assert.equal(await retry, 'http://dev.local:5173/?key=a%2Fb#app');
});

test('Developer QR saves and launches an app URL exactly once, preserving port/query/fragment', async () => {
  const f = layerFixture(); f.layer.open(f.ctx); f.layer.open(f.ctx);
  const url = 'http://dev.local:5173/?key=a%2Fb#app';
  f.instances[0].done(url, null); await flush();
  assert.deepEqual(f.saved, [url]); assert.deepEqual(f.launched, [url]);
  assert.equal(f.pops, 1); assert.equal(f.instances.length, 1);
});

test('Developer QR cancellation, invalid content and permission failure can all be retried', async () => {
  const f = layerFixture(); f.layer.open(f.ctx); f.instances[0].done(null, null); await flush();
  assert.match(f.layer.status, /cancelled/);
  f.layer.handleInput({ type: 'click' }, f.ctx); f.instances[1].done('file:///private/test', null); await flush();
  assert.match(f.layer.status, /Not a URL/);
  f.layer.handleInput({ type: 'click' }, f.ctx); f.instances[2].done(null, 'Camera denied'); await flush();
  assert.match(f.layer.status, /Camera denied/);
  assert.deepEqual(f.saved, []); assert.deepEqual(f.launched, []); assert.equal(f.pops, 0);
  f.layer.handleInput({ type: 'click' }, f.ctx); f.instances[3].done('https://example.com/', null); await flush();
  assert.equal(f.pops, 1);
});

test('leaving Developer QR cancels the camera and suppresses late results', async () => {
  const f = layerFixture(); f.layer.open(f.ctx);
  f.layer.handleInput({ type: 'double-click' }, f.ctx);
  const renders = f.renders;
  f.instances[0].done('https://example.com/', null); await flush();
  assert.equal(f.instances[0].cancelled, true);
  assert.deepEqual(f.saved, []); assert.deepEqual(f.launched, []);
  assert.equal(f.renders, renders); assert.equal(f.pops, 1);
});

test('leaving while an app launches cannot pop a replacement page or repaint the removed layer', async () => {
  const f = layerFixture(); let finish;
  f.launch(() => new Promise(resolve => { finish = resolve; }));
  f.layer.open(f.ctx); f.instances[0].done('https://example.com/', null); await flush();
  f.ctx.stack.pop(); const renders = f.renders;
  finish(); await flush();
  assert.equal(f.pops, 1); assert.equal(f.renders, renders);
});

test('iOS without a camera explains availability and can retry when available', async () => {
  const f = layerFixture(); f.available(false); f.layer.open(f.ctx);
  assert.match(f.layer.status, /physical iPhone/); assert.equal(f.instances.length, 0);
  f.available(true); f.layer.handleInput({ type: 'click' }, f.ctx);
  assert.equal(f.instances.length, 1); f.layer.onRemoved(); await flush();
});

test('Developer QR menu is enabled on iOS and pushes then opens its layer', () => {
  let menu, options; const calls = [];
  const { createDeveloperAppWindow } = load('app/apps/developer/developer-app.ts', {
    '../../ui/menu': { MenuLayer: class { constructor(_title, items) { menu = items; } } },
    '../../ui/shell/geometry': { appViewportSize: () => ({ height: 480 }) },
    '../../ui/shell/in-process-window': { YieldAtRootLayer: class {}, createInProcessWindow: value => { options = value; return {}; } },
    './load-app': { LoadAppFromQrLayer: class { open() { calls.push('open'); } } },
  }, { global: { isIOS: true } });
  createDeveloperAppWindow({}, {});
  const qr = menu.find(item => item.label === 'Load app from QR code');
  assert.ok(!qr.disabled); qr.onSelect({ stack: { push: () => calls.push('push') } });
  assert.deepEqual(calls, ['push', 'open']);
});
