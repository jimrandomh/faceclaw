const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');

function load(file, modules, globals) {
  const context = { exports: {}, require: name => {
    if (!(name in modules)) throw new Error(`Missing mock: ${name} in ${file}`);
    return modules[name];
  }, setInterval, clearInterval, Date, ...globals };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return context.exports;
}

function fixture({ glasses = 'g2', ios = false, completed = false, ring = false, watch = false, previewOnly = false } = {}) {
  const state = { glasses, ring, watch, navigations: [], backs: 0, previewOnly, completed };
  const frame = { navigate: entry => state.navigations.push(entry), goBack: () => { state.backs++; }, canGoBack: () => true, backStack: [] };
  class Observable { notifyPropertyChange() {} }
  const core = {
    Observable, Frame: { topmost: () => frame }, Screen: { mainScreen: { heightDIPs: 800, widthDIPs: 400 } },
    Application: { on() {}, off() {}, suspendEvent: 'suspend', resumeEvent: 'resume' },
  };
  const onboardingState = {
    hasCompletedOnboarding: () => state.completed,
    setOnboardingCompleted: value => { state.completed = value; },
    isPreviewOnlyMode: () => state.previewOnly, setPreviewOnlyMode: value => { state.previewOnly = value; },
    ownsRing: () => state.ring, setOwnsRing: value => { state.ring = value; },
    ownsWatch: () => state.watch, setOwnsWatch: value => { state.watch = value; },
  };
  const settings = { glassesTypeSetting: { get: () => state.glasses, set: value => { state.glasses = value; } } };
  const globals = { global: { isIOS: ios, isAndroid: !ios } };
  const modules = {
    '@nativescript/core': core, './onboarding-state': onboardingState, '../ui/dashboard-settings': settings,
    './onboarding-navigation': { finishOnboardingNavigation: () => state.navigations.push('finish') },
    '../g1/even-firmware': { EVEN_G1_RESTORE: { version: '1.6.6' } },
    '../native/even-app-conflict': { openEvenAppSettings() {} },
    '../native/ble-permissions': { ensureBlePermissions: async () => {} },
    '../g2/device-addresses': {
      loadDeviceAddresses: () => ({ right: '', left: '', ring: '' }), loadPairedGlassesIdentity: () => null,
      saveDeviceAddresses() {}, savePairedGlassesIdentity() {},
    },
    '../util/format-error': { formatErrorMessage: String },
    '../g2/pairing-candidates': {
      DiscoveryAggregator: class { prune() {} pairs() { return []; } rings() { return []; } rayneos() { return []; } clear() {} },
      DEFAULT_STALE_AFTER_MS: 1, nearestCandidateId: () => null,
    },
    '../native/device-discovery': { DeviceDiscoveryBridge: class {} },
  };
  // Permission checks: everything granted.
  const granted = new Proxy({}, { get: () => () => true });
  for (const name of ['../native/ios-bluetooth', '../g2/android-permissions', '../native/calendar-permissions', '../native/battery-optimization',
    '../native/file-access', '../native/notification-access']) modules[name] = granted;
  modules['../native/media-controller'] = { mediaControllerBridge: { hasAccess: () => true } };
  const loadPage = file => load(`app/phone-ui/${file}.ts`, modules, globals);
  return { state, loadPage };
}

const rowFor = (model, choice) => model.glassesOptions.find(option => option.choice === choice);
const selected = model => model.glassesOptions.filter(option => option.checkVisibility === 'visible').map(option => option.choice).join();
const tap = (model, type) => model.onGlassesRowTap({ object: { bindingContext: rowFor(model, type) } });

test('the devices page sits between the splash and the disclaimer', () => {
  const { state, loadPage } = fixture();
  const { OnboardingViewModel } = loadPage('onboarding-view-model');
  new OnboardingViewModel().onPrimaryTap();
  assert.equal(state.navigations.pop().moduleName, 'phone-ui/onboarding-devices-page');

  const { OnboardingDevicesViewModel } = loadPage('onboarding-devices-view-model');
  const devices = new OnboardingDevicesViewModel();
  tap(devices, 'g2');
  devices.onNextTap();
  const next = state.navigations.pop();
  assert.equal(next.moduleName, 'phone-ui/onboarding-page');
  assert.equal(next.context.step, 2);
  const disclaimer = new OnboardingViewModel(next.context.step);
  assert.equal(disclaimer.headline, 'Before You Continue');

  // Backing out of the disclaimer lands on the devices page, not the splash.
  disclaimer.onSecondaryTap();
  assert.equal(state.backs, 1);
  assert.equal(state.navigations.length, 0);
});

test('iOS registers the devices page, which it cannot resolve otherwise', () => {
  const source = fs.readFileSync('app/phone-ui/onboarding-register.ios.ts', 'utf8');
  assert.match(source, /registerModule\('phone-ui\/onboarding-devices-page', /);
  assert.match(source, /registerModule\('phone-ui\/onboarding-devices-page\.xml', /);
});

test('choosing glasses selects exactly one, and the accessories are stored', () => {
  const { state, loadPage } = fixture();
  const { OnboardingDevicesViewModel } = loadPage('onboarding-devices-view-model');
  const model = new OnboardingDevicesViewModel();
  assert.equal(model.glassesOptions.map(option => option.choice).join(), 'preview,g1,g2,rayneo-io');

  // Nothing is chosen until you choose, even with a stored glasses type, and Next waits for it.
  assert.equal(selected(model), '');
  assert.equal(model.nextEnabled, false);
  model.onNextTap();
  assert.equal(state.navigations.length, 0);

  tap(model, 'rayneo-io');
  assert.equal(state.glasses, 'rayneo-io');
  assert.equal(selected(model), 'rayneo-io');
  assert.equal(model.nextEnabled, true);

  assert.equal(model.hasRing, false);
  model.hasRing = true;
  model.hasWatch = true;
  assert.equal(state.ring, true);
  assert.equal(state.watch, true);
  assert.equal(new OnboardingDevicesViewModel().hasRing, true);
});

test('the watch follows the platform, and iOS can\'t choose a RayNeo iO', () => {
  const android = fixture();
  const onAndroid = new (android.loadPage('onboarding-devices-view-model').OnboardingDevicesViewModel)();
  assert.equal(onAndroid.watchLabel, 'Wear OS watch');
  assert.equal(rowFor(onAndroid, 'rayneo-io').noteVisibility, 'collapse');

  const ios = fixture({ ios: true });
  const onIos = new (ios.loadPage('onboarding-devices-view-model').OnboardingDevicesViewModel)();
  assert.equal(onIos.watchLabel, 'Apple Watch');
  assert.equal(rowFor(onIos, 'rayneo-io').noteVisibility, 'visible');
  tap(onIos, 'rayneo-io');
  assert.equal(ios.state.glasses, 'g2');
  assert.equal(selected(onIos), '');
  assert.equal(onIos.nextEnabled, false);
});

test('the disclaimer and firmware steps name only the chosen glasses', () => {
  const copy = glasses => {
    const { OnboardingViewModel } = fixture({ glasses }).loadPage('onboarding-view-model');
    return { disclaimer: new OnboardingViewModel(2), firmware: new OnboardingViewModel(3) };
  };
  const g2 = copy('g2'), g1 = copy('g1'), io = copy('rayneo-io');

  assert.match(g2.disclaimer.body, /for the Even Realities G2 smart glasses/);
  assert.doesNotMatch(g2.disclaimer.body, /G1|RayNeo/);
  assert.match(g1.disclaimer.body, /for the Even Realities G1 smart glasses/);
  assert.match(io.disclaimer.body, /for the RayNeo iO smart glasses\. It is not created or supported by RayNeo\./);
  assert.doesNotMatch(io.disclaimer.body, /Even/);

  assert.match(g2.firmware.body, /reconnecting the official Even Realities app/);
  assert.doesNotMatch(g2.firmware.body, /from Faceclaw|1\.6\.6|G1/);
  assert.match(g1.firmware.body, /return to the official firmware later from Faceclaw, as version 1\.6\.6\./);
  assert.doesNotMatch(g1.firmware.body, /reconnecting|G2/);
  assert.equal(g2.firmware.primaryLabel, 'Flash Firmware');
  assert.equal(g1.firmware.primaryLabel, 'Flash Firmware');
  // The app has no flasher for an iO.
  assert.equal(io.firmware.primaryLabel, 'Pair Glasses');
  assert.doesNotMatch(io.firmware.body, /Flash Firmware|Even/);

  // Preview Only moved to Your Devices: the firmware step only goes forward or back.
  for (const { firmware } of [g2, g1, io]) {
    assert.equal(firmware.secondaryLabel, 'Back');
    assert.doesNotMatch(firmware.body, /two choices/);
    assert.match(firmware.body, /Go back to Your Devices and choose Preview Only/);
  }
});

test('Preview Only is a glasses choice that skips the firmware step', () => {
  const { state, loadPage } = fixture({ glasses: 'rayneo-io' });
  const { OnboardingDevicesViewModel } = loadPage('onboarding-devices-view-model');
  const devices = new OnboardingDevicesViewModel();
  assert.equal(rowFor(devices, 'preview').noteVisibility, 'visible');

  tap(devices, 'preview');
  assert.equal(state.previewOnly, true);
  assert.equal(state.glasses, 'rayneo-io');
  assert.equal(selected(devices), 'preview');
  assert.equal(devices.nextEnabled, true);
  // A later visit (say, after restarting mid-setup) asks again.
  assert.equal(selected(new OnboardingDevicesViewModel()), '');

  // The disclaimer can't name glasses nobody chose.
  const { OnboardingViewModel } = loadPage('onboarding-view-model');
  assert.match(new OnboardingViewModel(2).body, /for the Even Realities G1 and G2 and RayNeo iO smart glasses\. It is not created or supported by Even Realities or RayNeo\./);

  // Permissions is the last page: onboarding completes there, in preview mode.
  const { PermissionsViewModel } = loadPage('permissions-view-model');
  return new PermissionsViewModel({ onboarding: true }).onPrimaryTap().then(async () => {
    assert.equal(state.completed, true);
    assert.deepEqual(state.navigations, ['finish']);

    // Choosing glasses again turns preview off, and Permissions leads to the firmware step.
    state.completed = false;
    state.navigations.length = 0;
    tap(devices, 'g1');
    assert.equal(state.previewOnly, false);
    assert.equal(state.glasses, 'g1');
    await new PermissionsViewModel({ onboarding: true }).onPrimaryTap();
    assert.equal(state.completed, false);
    assert.equal(state.navigations[0].moduleName, 'phone-ui/onboarding-page');
    assert.equal(state.navigations[0].context.step, 3);

    // And that step's Back returns to Permissions.
    new OnboardingViewModel(3).onSecondaryTap();
    assert.equal(state.backs, 1);
  });
});

test('the disconnect page drops the Even app instructions only when setting up an iO', () => {
  const page = options => new (fixture(options).loadPage('onboarding-unpair-view-model').OnboardingUnpairViewModel)();
  const setup = page({ glasses: 'rayneo-io' });
  assert.equal(setup.evenAppVisibility, 'collapse');
  assert.equal(setup.settingsButtonVisibility, 'collapse');
  assert.doesNotMatch(setup.otherAppsInstructions, /Even/);

  for (const options of [{ glasses: 'g2' }, { glasses: 'rayneo-io', completed: true }]) {
    const model = page(options);
    assert.equal(model.evenAppVisibility, 'visible');
    assert.equal(model.settingsButtonVisibility, 'visible');
    assert.match(model.otherAppsInstructions, /Even Realities/);
  }
});

test('pairing during setup follows the choices; from the menu it offers everything', () => {
  const page = (options, onboarding = true) => new (fixture(options).loadPage('pairing-view-model').PairingViewModel)({ onboarding });

  const g1 = page({ glasses: 'g1' });
  assert.match(g1.instructions, /^Select your G1 glasses below\. Put the glasses in their case with the lid open/);
  assert.equal(g1.ringSectionVisibility, 'collapse');

  const io = page({ glasses: 'rayneo-io', ring: true });
  assert.match(io.instructions, /^Select your RayNeo iO and your R1 ring below\. Wear the glasses/);
  assert.equal(io.ringSectionVisibility, 'visible');

  // Past setup, "Pair glasses" re-enters with onboarding set, including for an
  // install from before the devices page existed (nothing stored: no ring).
  for (const model of [page({ glasses: 'g2', completed: true }), page({ glasses: 'g2' }, false)]) {
    assert.match(model.instructions, /G2 or G1 glasses or RayNeo iO, and your R1 ring if you have one/);
    assert.equal(model.ringSectionVisibility, 'visible');
  }
});
