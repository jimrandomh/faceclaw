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
const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) { await flush(); await new Promise(resolve => setTimeout(resolve, 0)); } };
// The Kotlin facades (FaceclawKitIos*) deliver listener callbacks on the main queue; the
// fakes call the TypeScript listener object directly. NSObject.extend is how the wrappers
// implement Kotlin listener protocols.
const nsObject = { extend: methods => ({ new: () => ({ ...methods }) }) };
function bluetooth(identifiers = { right: 'R-ID', left: 'L-ID' }, fail = null) {
  return { iosBluetooth: () => ({ resolveDevices: async addresses => {
    if (fail) throw new Error(fail);
    return Object.fromEntries(Object.entries(identifiers).filter(([role]) => addresses[role]));
  } }) };
}
function flasherFixture({ hash = 'custom', outcome = 'success', backgroundOn = '', resolveError = null } = {}) {
  const calls = [], events = new Map(), native = { idleTimerDisabled: false, applicationState: 0 }, instances = [];
  const app = { suspendEvent: 'suspend', on: (e, cb) => events.set(e, cb), off: e => events.delete(e) };
  const FaceclawKitIosFirmwareFlasher = { alloc: () => ({ initWithRightAddressLeftAddressFirmwarePath(right, left, path) {
    const flasher = { listener: null, cancelled: false, closed: false,
      setListenerListener(listener) { this.listener = listener; },
      start() {
        calls.push(`start:${right}:${left}:${path}`);
        setTimeout(() => {
          for (const lens of ['left', 'right']) {
            if (this.cancelled) break;
            this.listener.onStateStateDetail('connecting', lens); this.listener.onStateStateDetail('flashing', lens);
            this.listener.onProgressLensComponentIndexComponentCountBlockIndexBlockCountBytesSentBytesTotal(lens, 1, 1, 1, 1, 16, 16);
            if (lens === backgroundOn) events.get('suspend')();
            if (outcome === 'fail' && lens === 'right') { this.listener.onCompleteSuccessDetail(false, 'END rejected'); return; }
          }
          if (this.cancelled) { this.listener.onCompleteSuccessDetail(false, 'Cancelled. Retry with both lenses powered on to complete installation.'); return; }
          this.listener.onStateStateDetail('done', 'Both lenses flashed. Your glasses are rebooting.');
          this.listener.onCompleteSuccessDetail(true, 'Both lenses flashed. Your glasses are rebooting.');
        }, 0);
      },
      cancel() { this.cancelled = true; calls.push('cancel'); }, close() { this.closed = true; calls.push('close'); } };
    instances.push(flasher); return flasher;
  } }) };
  const { FirmwareFlasher } = load('app/native/firmware-flasher.ios.ts', {
    '@nativescript/core': { Application: app },
    '../g2/firmware/cfw-patches': { CFW_PATCH_SET: { outputSha256: 'custom', baseSha256: 'stock' } },
    './firmware-files.ios': { readFirmwareFile: () => new Uint8Array(16), firmwareSha256: () => hash },
    './ios-bluetooth': bluetooth({ right: 'R-ID', left: 'L-ID' }, resolveError), './kotlin-listener.ios': listenerModule,
  }, { UIApplication: { sharedApplication: native }, UIApplicationState: { Active: 0 }, FaceclawKitIosFirmwareFlasher, FaceclawKitFaceclawFirmwareFlasherListener: {} });
  const flasher = new FirmwareFlasher({ right: 'r', left: 'l' }, 'prepared.bin');
  const states = [], progress = [];
  flasher.onStateChange((state, detail) => states.push(`${state}:${detail}`)); flasher.onProgress(value => progress.push(value.lens));
  const result = new Promise(resolve => flasher.onComplete((success, detail) => resolve({ success, detail })));
  return { calls, events, native, flasher, result, instances, states, progress };
}
const listenerModule = load('app/native/kotlin-listener.ios.ts', {}, { NSObject: nsObject });

test('iOS flashing checks the image hash, resolves identifiers, runs the Kotlin OTA flow and reports success', async () => {
  for (const hash of ['custom', 'stock']) {
    const f = flasherFixture({ hash }); f.flasher.start(); f.flasher.start();
    assert.equal((await f.result).success, true);
    assert.deepEqual(f.calls, ['start:R-ID:L-ID:prepared.bin', 'close']);
    assert.equal(f.native.idleTimerDisabled, false); assert.equal(f.events.size, 0);
    await settle();
    assert.deepEqual(f.states, ['validating:', 'connecting:left', 'flashing:left', 'connecting:right', 'flashing:right', 'done:Both lenses flashed. Your glasses are rebooting.']);
    assert.deepEqual(f.progress, ['left', 'right']);
  }
});

test('iOS flashing refuses a changed image before Bluetooth and never reports partial success', async () => {
  const invalid = flasherFixture({ hash: 'changed' }); invalid.flasher.start();
  assert.match((await invalid.result).detail, /SHA-256/); assert.deepEqual(invalid.calls, []); assert.equal(invalid.native.idleTimerDisabled, false);
  const unresolved = flasherFixture({ resolveError: 'Could not find the left arm.' }); unresolved.flasher.start();
  assert.match((await unresolved.result).detail, /left arm/); assert.deepEqual(unresolved.calls, []);
  const failure = flasherFixture({ outcome: 'fail' }); failure.flasher.start();
  const result = await failure.result; assert.equal(result.success, false); assert.match(result.detail, /END rejected/);
  assert.equal(failure.native.idleTimerDisabled, false); assert.equal(failure.events.size, 0); assert.equal(failure.calls.includes('close'), true);
});

test('backgrounding during iOS OTA stops the transfer and directs retry of both lenses', async () => {
  const f = flasherFixture({ backgroundOn: 'left' }); f.flasher.start();
  const result = await f.result;
  assert.equal(result.success, false); assert.match(result.detail, /left the foreground.*retry both lenses/);
  assert.equal(f.instances[0].cancelled, true); assert.equal(f.progress.includes('right'), false); assert.equal(f.native.idleTimerDisabled, false);
});

test('iOS firmware prompt maps addresses to identifiers, forwards the Kotlin flow events and surfaces its errors', async () => {
  const instances = [];
  const FaceclawKitIosFlashPrompt = { alloc: () => ({ initWithRightAddressLeftAddressWarningTextSkipPrompt(right, left, warning, skip) {
    const prompt = { args: [right, left, warning, skip], listener: null, closed: false, started: 0,
      setListenerListener(listener) { this.listener = listener; }, start() { this.started++; }, cancel() {}, close() { this.closed = true; } };
    instances.push(prompt); return prompt;
  } }) };
  const { FlashPromptCommunicator } = load('app/native/flash-prompt-communicator.ios.ts', {
    './ios-bluetooth': bluetooth(), './kotlin-listener.ios': listenerModule,
  }, { FaceclawKitIosFlashPrompt, FaceclawKitFaceclawFlashPromptListener: {} });
  const prompt = new FlashPromptCommunicator({ right: 'r', left: 'l' }, 'warning', { skipPrompt: true }), states = [], results = [], batteries = [];
  prompt.onStateChange((state, detail) => states.push(`${state}:${detail}`)); prompt.onResult(approved => results.push(approved)); prompt.onBattery(b => batteries.push(b));
  prompt.start(); prompt.start(); await settle();
  assert.equal(instances.length, 1); assert.deepEqual(instances[0].args, ['R-ID', 'L-ID', 'warning', true]); assert.equal(instances[0].started, 1);
  const listener = instances[0].listener;
  listener.onStateStateDetail('connected', ''); listener.onBatteryRightPercentLeftPercent(88, -1); listener.onResultApproved(true);
  listener.onStateStateDetail('error', 'Lost connection to the right lens.'); await settle();
  assert.deepEqual(states, ['connecting:', 'connected:', 'error:Lost connection to the right lens.']);
  assert.deepEqual(JSON.parse(JSON.stringify(batteries)), [{ right: 88, left: null }]); assert.deepEqual(results, [true]);
  prompt.close(); assert.equal(instances[0].closed, true);
  const unresolved = load('app/native/flash-prompt-communicator.ios.ts', {
    './ios-bluetooth': bluetooth({}, 'Wake the glasses.'), './kotlin-listener.ios': listenerModule,
  }, { FaceclawKitIosFlashPrompt, FaceclawKitFaceclawFlashPromptListener: {} });
  const failed = new unresolved.FlashPromptCommunicator({ right: 'r', left: 'l' }, 'warning'), errors = [];
  failed.onStateChange((state, detail) => { if (state === 'error') errors.push(detail); });
  failed.start(); await settle(); assert.deepEqual(errors, ['Wake the glasses.']); assert.equal(instances.length, 1);
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
    '../util/http': { fetchWithUserAgent: async (url) => {
      const md5 = crypto.createHash('md5').update(base).digest('hex');
      assert.equal(url, `https://cdn.evenreal.co/firmware/${md5}.bin`);
      return { ok: true, arrayBuffer: async () => Uint8Array.from(base).buffer };
    } },
    '../util/hex-util': require('../.test-build/app/util/hex-util.js'), '../graphics/evenhub-font': { EvenHubFont: { invalidate() {} } },
    '../native/firmware-files': { firmwareSha256: hash, writeFirmwareFile: (file, buffer) => fs.writeFileSync(file, new Uint8Array(buffer)) },
  });
  const stock = await builder.buildStockFirmware(); assert.equal(stock.sha256, patches.CFW_PATCH_SET.baseSha256);
  const custom = await builder.buildCustomFirmware(); assert.equal(hash(fs.readFileSync(custom.path)), patches.CFW_PATCH_SET.outputSha256);
  assert.equal(builder.hasExtractedEvenHubFonts(), true);
});

test('iOS firmware probe resolves identifiers, runs the Kotlin flow and settles once', async () => {
  const instances = [];
  const FaceclawKitIosDeviceInfoProbe = { alloc: () => ({ initWithRightAddressLeftAddress(right, left) {
    const probe = { args: [right, left], listener: null, closed: 0, setListenerListener(listener) { this.listener = listener; }, start() { this.started = true; }, cancel() {}, close() { this.closed++; } };
    instances.push(probe); return probe;
  } }) };
  const { DeviceInfoProbe } = load('app/native/device-info-probe.ios.ts', {
    './ios-bluetooth': bluetooth(), './kotlin-listener.ios': listenerModule,
  }, { FaceclawKitIosDeviceInfoProbe, FaceclawKitFaceclawDeviceInfoProbeListener: {} });
  const probe = new DeviceInfoProbe('r', 'l'), states = [];
  probe.onStateChange((state, detail) => states.push(`${state}:${detail}`));
  const pending = probe.run(); await settle();
  assert.deepEqual(instances[0].args, ['R-ID', 'L-ID']); assert.equal(instances[0].started, true);
  instances[0].listener.onStateStateDetail('querying', 'right');
  instances[0].listener.onResultLeftVersionRightVersionExtension('2.2.9.22', '2.2.9.22', 'faceclaw/13');
  instances[0].listener.onErrorMessage('late error is ignored');
  const info = await pending; await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(info)), { leftVersion: '2.2.9.22', rightVersion: '2.2.9.22', extension: 'faceclaw/13' });
  assert.deepEqual(states, ['connecting:right', 'querying:right']); assert.equal(instances[0].closed, 1);
  const failing = new DeviceInfoProbe('r'); const failed = failing.run(); await settle();
  assert.deepEqual(instances[1].args, ['R-ID', '']);
  instances[1].listener.onErrorMessage("Connected, but couldn't read a firmware version.");
  await assert.rejects(failed, /firmware version/);
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
