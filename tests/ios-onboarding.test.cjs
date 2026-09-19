const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const crypto = require('node:crypto'), os = require('node:os'), path = require('node:path');
function load(file, modules = {}, globals = {}) {
  const context = { exports: {}, require: name => {
    if (!(name in modules)) throw new Error(`Missing mock: ${name} in ${file}`);
    return modules[name];
  }, Uint8Array, ArrayBuffer, DataView, setTimeout, clearTimeout, setInterval, clearInterval, ...globals };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return context.exports;
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function flasherFixture({ hash = 'custom', failRole = '', backgroundRole = '' } = {}) {
  const calls = [], events = new Map(), native = { idleTimerDisabled: false, applicationState: 0 };
  const app = { suspendEvent: 'suspend', on: (e, cb) => events.set(e, cb), off: e => events.delete(e) };
  class Link {
    closed = false;
    check() { if (this.closed) throw new Error('Cancelled'); }
    async resolve() { calls.push('resolve'); }
    async connect(role, ota) { this.check(); calls.push(`connect:${role}:${ota}`); }
    async authenticate(role) { this.check(); calls.push(`auth:${role}`); }
    disconnect(role) { calls.push(`disconnect:${role}`); }
    close() { this.closed = true; calls.push('close'); }
  }
  const { FirmwareFlasher } = load('app/native/firmware-flasher.ios.ts', {
    '@nativescript/core': { Application: app }, '../g2/stock-connection': { StockConnection: Link },
    '../g2/firmware/cfw-patches': { CFW_PATCH_SET: { outputSha256: 'custom', baseSha256: 'stock' } },
    './firmware-files.ios': { readFirmwareFile: () => new Uint8Array(16), firmwareSha256: () => hash },
    './ios-bluetooth': { iosBluetooth: () => ({}) },
    '../g2/firmware-ota': { validateFirmware: () => { calls.push('validate'); return []; },
      flashLensImage: async (link, role) => {
        calls.push(`flash:${role}`);
        if (role === backgroundRole) events.get('suspend')();
        link.check();
        if (role === failRole) throw new Error('END rejected');
      } },
  }, { UIApplication: { sharedApplication: native }, UIApplicationState: { Active: 0 },
    setTimeout: fn => setTimeout(fn, 0) });
  const flasher = new FirmwareFlasher({ right: 'r', left: 'l' }, 'prepared.bin');
  const result = new Promise(resolve => flasher.onComplete((success, detail) => resolve({ success, detail })));
  return { calls, events, native, flasher, result };
}

test('iOS flashing authenticates and verifies both lenses in order before reporting success', async () => {
  for (const hash of ['custom', 'stock']) {
    const f = flasherFixture({ hash }); f.flasher.start(); f.flasher.start();
    assert.equal((await f.result).success, true);
    assert.deepEqual(f.calls, ['validate', 'resolve', 'connect:left:true', 'auth:left', 'flash:left', 'disconnect:left',
      'connect:right:true', 'auth:right', 'flash:right', 'disconnect:right', 'close']);
    assert.equal(f.native.idleTimerDisabled, false); assert.equal(f.events.size, 0);
  }
});

test('iOS flashing refuses a changed image before Bluetooth and never reports partial success', async () => {
  const invalid = flasherFixture({ hash: 'changed' }); invalid.flasher.start();
  assert.match((await invalid.result).detail, /SHA-256/); assert.deepEqual(invalid.calls, ['close']);
  const failure = flasherFixture({ failRole: 'right' }); failure.flasher.start();
  const result = await failure.result; assert.equal(result.success, false); assert.match(result.detail, /END rejected/);
  assert.equal(failure.native.idleTimerDisabled, false); assert.equal(failure.events.size, 0);
});

test('backgrounding during iOS OTA stops the transfer and directs retry of both lenses', async () => {
  const f = flasherFixture({ backgroundRole: 'left' }); f.flasher.start();
  const result = await f.result;
  assert.equal(result.success, false); assert.match(result.detail, /left the foreground.*retry both lenses/);
  assert.equal(f.calls.includes('flash:right'), false); assert.equal(f.native.idleTimerDisabled, false);
});

test('iOS firmware prompt surfaces heartbeat disconnection instead of leaving confirmation stuck', async () => {
  let heartbeat;
  const p = require('../.test-build/app/g2/ble-protocol.js');
  class Link {
    async resolve() {} async connect() {} async authenticate() {} async request() {}
    onMessage() { return () => {}; } nextMagic() { return 1; } close() {}
    async write() { throw new Error('Lost connection to the right lens.'); }
  }
  const { FlashPromptCommunicator } = load('app/native/flash-prompt-communicator.ios.ts', {
    '../g2/stock-connection': { StockConnection: Link }, '../g2/flash-prompt-protocol': {}, '../g2/ble-protocol': p,
    './ios-bluetooth': { iosBluetooth: () => ({}) },
  }, { setInterval: fn => { heartbeat = fn; return 1; }, clearInterval() {} });
  const prompt = new FlashPromptCommunicator({ right: 'r', left: 'l' }, 'warning'), errors = [];
  prompt.onStateChange((state, detail) => { if (state === 'error') errors.push(detail); });
  prompt.start(); await flush(); heartbeat(); await flush();
  assert.deepEqual(errors, ['Lost connection to the right lens.']); prompt.close();
});

test('iOS onboarding returns to the existing main controller, or creates it after first setup', () => {
  const calls = [], main = { entry: { moduleName: 'phone-ui/main-page' } }, stack = [main];
  const { finishOnboardingNavigation } = load('app/phone-ui/onboarding-navigation.ts', {
    '@nativescript/core': { Frame: { topmost: () => ({ backStack: stack, goBack: entry => calls.push(entry), navigate: entry => calls.push(entry) }) } },
  }, { global: { isIOS: true } });
  finishOnboardingNavigation(); assert.equal(calls[0], main);
  stack.length = 0; finishOnboardingNavigation();
  assert.equal(calls[1].moduleName, 'phone-ui/main-page'); assert.equal(calls[1].clearHistory, true);
});

test('pinned stock firmware reproduces the custom image, extracts fonts, and passes OTA validation', {
  skip: !process.env.FACECLAW_TEST_STOCK_FIRMWARE && 'Set FACECLAW_TEST_STOCK_FIRMWARE to the pinned stock .bin',
}, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'faceclaw-firmware-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const base = fs.readFileSync(process.env.FACECLAW_TEST_STOCK_FIRMWARE);
  const hash = buffer => crypto.createHash('sha256').update(new Uint8Array(buffer)).digest('hex');
  const patches = load('app/g2/firmware/cfw-patches.ts'), fonts = load('app/g2/firmware-fonts.ts');
  const builder = load('app/g2/firmware-builder.ts', {
    '@nativescript/core': { File: { exists: fs.existsSync, fromPath: file => ({ readTextSync: () => fs.readFileSync(file, 'utf8') }) },
      knownFolders: { documents: () => ({ path: temp, getFile: name => ({ writeTextSync: text => fs.writeFileSync(path.join(temp, name), text) }) }) } },
    './firmware/cfw-patches': patches, './firmware-fonts': fonts,
    '../util/http': { fetchWithUserAgent: async () => ({ ok: true, arrayBuffer: async () => Uint8Array.from(base).buffer }) },
    '../util/hex-util': require('../.test-build/app/util/hex-util.js'), '../graphics/evenhub-font': { EvenHubFont: { invalidate() {} } },
    '../native/firmware-files': { firmwareSha256: hash, writeFirmwareFile: (file, buffer) => fs.writeFileSync(file, new Uint8Array(buffer)) },
  });
  const { validateFirmware } = require('../.test-build/app/g2/firmware-ota.js');
  const stock = await builder.buildStockFirmware(); assert.equal(stock.sha256, patches.CFW_PATCH_SET.baseSha256);
  assert.equal(validateFirmware(fs.readFileSync(stock.path)).length, 6);
  const custom = await builder.buildCustomFirmware(); assert.equal(hash(fs.readFileSync(custom.path)), patches.CFW_PATCH_SET.outputSha256);
  assert.equal(validateFirmware(fs.readFileSync(custom.path)).length, 6);
  assert.equal(builder.hasExtractedEvenHubFonts(), true);
});

for (const unsolicited of [false, true]) test(`iOS firmware probe ${unsolicited ? 'accepts a version push with device-owned magic' : 'falls back to the left lens after a silent right lens'}`, async () => {
  const p = require('../.test-build/app/g2/ble-protocol.js'), calls = [];
  let listener;
  const str = (field, text) => p.bytes(field, new Uint8Array(Buffer.from(text)));
  const version = { sid: p.SID.settings, payload: p.concat(p.bytes(4, p.concat(str(5, '2.2.9.22'), str(6, '2.2.9.22'))), str(100, 'faceclaw/13')) };
  class Link {
    onMessage(fn) { listener = fn; } async resolve() {} check() {} isConnected() { return true; }
    async connect(role) { calls.push(`connect:${role}`); }
    async authenticate(role) { calls.push(`auth:${role}`); }
    async request(role, sid) {
      if (sid === p.SID.launch) return {};
      if (role === 'right') { if (unsolicited) listener(role, version); throw new Error('Timeout'); }
      return version;
    }
    close() { calls.push('close'); }
  }
  const { DeviceInfoProbe } = load('app/native/device-info-probe.ios.ts', {
    '../g2/stock-connection': { StockConnection: Link, StockTimeout: class extends Error {} },
    '../g2/ble-protocol': p, './ios-bluetooth': { iosBluetooth: () => ({}) },
  });
  const info = await new DeviceInfoProbe('r', 'l').run();
  assert.equal(info.rightVersion, '2.2.9.22'); assert.equal(info.leftVersion, '2.2.9.22'); assert.equal(info.extension, 'faceclaw/13');
  assert.deepEqual(calls, ['connect:right', 'auth:right', 'connect:left', 'auth:left', 'close']);
});

test('iOS discovery stops pending scans on cancellation and ignores a late permission result', async () => {
  const listeners = new Set(); let ready = async () => {}, starts = 0, stops = 0;
  const ble = { state: 5, scanning: false, devices: new Map(),
    ensureReady: () => ready(), onEvent: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    startScan: async () => { starts++; }, stopScan: () => { stops++; },
  };
  const { DeviceDiscoveryBridge } = load('app/native/device-discovery.ios.ts', {
    './ios-bluetooth': { iosBluetooth: () => ble }, './device-discovery-common': {},
  });
  const discovery = new DeviceDiscoveryBridge();
  const pending = discovery.scanCandidates(60_000); await flush(); discovery.stopScan();
  await assert.rejects(pending, /cancelled/); assert.equal(listeners.size, 0); assert.equal(starts, 1);
  let release; ready = () => new Promise(resolve => { release = resolve; });
  const waiting = discovery.scanCandidates(); discovery.stopScan(); release();
  await assert.rejects(waiting, /cancelled/); assert.equal(starts, 1); assert.equal(stops, 1);
});
