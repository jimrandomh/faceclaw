const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loader } = require('./helpers/load-typescript.cjs');

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

/** A native bridge whose listeners the test fires by name: `fire.onProgress({...})`. */
function bridge(created) {
  return class {
    constructor() {
      this.fire = {};
      created.push(this);
      return new Proxy(this, { get: (target, name) => name in target ? target[name]
        : String(name).startsWith('on') ? listener => { target.fire[name] = listener; return () => {}; } : () => {} });
    }
  };
}

function harness() {
  const prompts = [], flashers = [];
  class Observable { notifyPropertyChange() {} set(name, value) { this[name] = value; } }
  const load = loader({ global: { isAndroid: true, isIOS: false } }, {
    '@nativescript/core': { Observable, Frame: { topmost: () => null } },
    './onboarding-navigation': { finishOnboardingNavigation() {} },
    './onboarding-state': { setOnboardingCompleted() {}, setPreviewOnlyMode() {} },
    '../native/ble-permissions': { ensureBlePermissions: async () => {} },
    '../g2/device-addresses': {
      isValidMacAddress: () => true, loadDeviceAddresses: () => ({ right: 'R', left: 'L', ring: '' }),
      loadPairedGlassesIdentity: () => null, saveDeviceAddresses() {},
    },
    '../g2/firmware-builder': {
      buildCustomFirmware: async () => ({ path: 'cfw.bin', bytes: 4096 }), buildStockFirmware: async () => ({ path: 'stock.bin', bytes: 4096 }),
      FirmwareBuildError: class extends Error {}, hasExtractedEvenHubFonts: () => true, downloadAndExtractEvenHubFonts: async () => {},
    },
    '../native/device-discovery': { buildAddressSet: () => ({}), DeviceDiscoveryBridge: class { stopScan() {} } },
    '../native/firmware-flasher': { FirmwareFlasher: bridge(flashers) },
    '../native/flash-prompt-communicator': { FlashPromptCommunicator: bridge(prompts) },
    '../g2/reconnect-policy': { resumeAutoReconnect() {}, suppressAutoReconnect() {} },
    '../util/format-error': { formatErrorMessage: String },
    '../g1/arm-scanner': { G1ArmScanner: class { stop() {} } },
    '../g1/even-firmware': { EVEN_G1_RESTORE: { version: '1.6.6' } },
    '../g1/firmware/g1v0-image': { G1V0_IMAGE: { version: '0.5.66' } },
    '../g1/firmware-builder': {}, '../g1/addresses': {}, '../native/g1-flasher': {},
  });
  return { prompts, flashers, load };
}

/** A G2 install taken as far as the first lens being written. */
async function flashing() {
  const h = harness();
  const { OnboardingFlashViewModel } = h.load('app/phone-ui/onboarding-flash-view-model.ts');
  const model = new OnboardingFlashViewModel({ autoStart: true });
  await settle();
  h.prompts[0].fire.onLog('right arm connected');
  h.prompts[0].fire.onResult(true);
  await settle();
  const flasher = h.flashers[0].fire;
  flasher.onStateChange('flashing', 'left');
  flasher.onProgress({ lens: 'left', componentIndex: 2, componentCount: 5, blockIndex: 37, blockCount: 212, bytesSent: 500, bytesTotal: 1000 });
  return { model, flasher };
}

test('the flash page keeps its block counter and log behind Show Details', async () => {
  const { model, flasher } = await flashing();
  assert.equal(model.headline, 'Flashing Firmware');
  assert.equal(model.progress, 25);
  // What everyone sees doesn't change block by block.
  assert.equal(model.status, 'Flashing the left lens. Keep the glasses on and nearby.');
  assert.equal(model.progressDetail, 'Left lens: part 2/5, block 37/212');
  assert.match(model.log, /^\[\d\d:\d\d:\d\d\] right arm connected\n[^]*confirmed on the lens; battery ok\n.*custom firmware prepared and verified/);

  assert.equal(model.detailsToggleLabel, 'Show Details');
  assert.equal(model.detailsToggleVisibility, 'visible');
  assert.equal(model.detailsVisibility, 'collapse');

  model.onToggleDetailsTap();
  assert.equal(model.detailsToggleLabel, 'Hide Details');
  assert.equal(model.detailsVisibility, 'visible');
  assert.equal(model.progressDetailVisibility, 'visible');
  assert.equal(model.logVisibility, 'visible');

  flasher.onProgress({ lens: 'right', componentIndex: 1, componentCount: 5, blockIndex: 1, blockCount: 9, bytesSent: 0, bytesTotal: 1000 });
  assert.equal(model.status, 'Flashing the right lens. Keep the glasses on and nearby.');
  assert.equal(model.progressDetail, 'Right lens: part 1/5, block 1/9');

  // Done: the counter goes, the log stays, and the expander is as the user left it.
  flasher.onComplete(true, '');
  assert.equal(model.headline, 'All Done');
  assert.equal(model.progressDetailVisibility, 'collapse');
  assert.equal(model.detailsVisibility, 'visible');
  model.onToggleDetailsTap();
  assert.equal(model.detailsVisibility, 'collapse');
  assert.equal(model.detailsToggleVisibility, 'visible');
});

test('a failed flash keeps where it stopped behind Show Details', async () => {
  const { model, flasher } = await flashing();
  flasher.onComplete(false, 'The left lens stopped answering.');
  assert.equal(model.headline, 'Something Went Wrong');
  assert.equal(model.status, 'The left lens stopped answering.');
  assert.equal(model.detailsVisibility, 'collapse');
  assert.equal(model.progressDetail, 'Left lens: part 2/5, block 37/212');
});

test('there is no expander until there are details, on a G2 or a G1', () => {
  const { load } = harness();
  const page = fs.readFileSync('app/phone-ui/onboarding-flash-page.xml', 'utf8');
  const bindings = [...page.matchAll(/\{\{ (\w+) \}\}/g)].map(match => match[1]);
  assert.ok(bindings.includes('onToggleDetailsTap'));
  // The log and the block counter sit inside the collapsible part.
  assert.match(page, /<StackLayout visibility="\{\{ detailsVisibility \}\}">(?:\s*<Label text="\{\{ (?:progressDetail|log) \}\}"[^>]*\/>){2}\s*<\/StackLayout>/);

  const models = [
    new (load('app/phone-ui/onboarding-flash-view-model.ts').OnboardingFlashViewModel)(),
    new (load('app/phone-ui/g1-flash-view-model.ts').G1FlashViewModel)(),
  ];
  for (const model of models) {
    // One page serves both models, so each has to supply everything it binds.
    for (const name of bindings) assert.ok(name in model, `${model.constructor.name} lacks ${name}`);
    assert.equal(model.detailsToggleVisibility, 'collapse');
    assert.equal(model.detailsVisibility, 'collapse');
    model.onToggleDetailsTap();
    assert.equal(model.detailsVisibility, 'collapse');
    model.appendLog('listening');
    assert.equal(model.detailsToggleVisibility, 'visible');
    assert.equal(model.detailsVisibility, 'visible');
    assert.match(model.log, /^\[\d\d:\d\d:\d\d\] listening$/);
  }
});
