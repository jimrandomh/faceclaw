// The flash cannot always ask for confirmation on the lens: firmware older than
// the revision this build needs accepts the create-prompt write and then never
// answers it. Flashing is the only way off that firmware, so an unacked prompt
// must not be a dead end. These cover the decision at that seam.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function fixture() {
  class Observable { notifyPropertyChange() {} }
  const load = loader({}, {
    '@nativescript/core': { Observable, Frame: { topmost: () => null } },
    './onboarding-navigation': { finishOnboardingNavigation() {} },
    './onboarding-state': { setOnboardingCompleted() {}, setPreviewOnlyMode() {} },
    '../native/ble-permissions': { ensureBlePermissions: async () => {} },
    '../g2/device-addresses': {
      isValidMacAddress: () => true,
      loadDeviceAddresses: () => ({ right: 'R', left: 'L' }),
      saveDeviceAddresses() {},
    },
    '../g2/firmware-builder': {
      buildCustomFirmware: async () => '', buildStockFirmware: async () => '',
      FirmwareBuildError: class extends Error {}, FirmwareProgress: {},
    },
    '../native/device-discovery': { buildAddressSet: () => new Set(), DeviceDiscoveryBridge: class {} },
    '../native/firmware-flasher': { FirmwareFlasher: class {} },
    '../native/flash-prompt-communicator': { FlashPromptCommunicator: class {} },
    '../g2/reconnect-policy': { resumeAutoReconnect() {}, suppressAutoReconnect() {} },
    '../util/format-error': { formatErrorMessage: (e) => String(e) },
  });
  const mod = load('app/phone-ui/onboarding-flash-view-model.ts');
  const Model = mod.OnboardingFlashViewModel ?? Object.values(mod).find((v) => typeof v === 'function');
  const model = new Model();
  const beginArgs = [];
  model.beginPrompt = async (options) => { beginArgs.push(options); };
  return { model, beginArgs };
}

test('an unacked prompt page offers the phone-side confirmation instead of dead-ending', () => {
  const { model, beginArgs } = fixture();
  model.handlePromptState('error', 'prompt page not acked: AA:BB:CC:DD:EE:FF', false);
  assert.equal(model.phase, 'error');
  assert.equal(model.headline, 'Confirm On Your Phone');
  assert.equal(model.primaryLabel, 'Confirm & Install', 'the action is a confirmation, not a retry');
  assert.match(model.status, /can't show the confirmation prompt/i);
  model.retryAction();
  // The loader runs the module in its own vm realm, so the options object has that
  // realm's prototype and deepStrictEqual would reject it. Compare the field.
  assert.equal(beginArgs.length, 1);
  assert.equal(beginArgs[0].skipPrompt, true, 'confirming must skip the lens prompt, not re-ask for it');
});

test('any other prompt failure still reports as an ordinary retry', () => {
  const { model, beginArgs } = fixture();
  model.handlePromptState('error', 'discoverServices failed: right arm', false);
  assert.equal(model.phase, 'error');
  assert.equal(model.headline, 'Something Went Wrong');
  assert.equal(model.primaryLabel, 'Retry');
  model.retryAction();
  assert.equal(beginArgs.length, 1);
  assert.equal(beginArgs[0].skipPrompt, false, 'an ordinary failure must not silently skip the lens prompt');
});
