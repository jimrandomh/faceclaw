const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const NO_LEVELS = { headset: null, headsetCharging: null, case: null, caseCharging: null, ring: null, ringCharging: null };

function fixture(android = false, bandAvailable = android) {
  let brightness = '40', mode = 'small', style = 'watch', picked, levels = { ...NO_LEVELS };
  const changes = [], writes = [], back = [];
  const settingListeners = new Set(), batteryListeners = new Set(), watchListeners = new Set();
  // Android's answer, and an iPhone's with no watch session yet.
  const watch = { state: 'unknown', source: null, opened: 0 };
  const subscribe = listeners => fn => { listeners.add(fn); return () => listeners.delete(fn); };
  class Observable {
    notifyPropertyChange(name, value) { changes.push([name, value]); }
  }
  const settings = {
    brightnessSetting: { get: () => brightness, set: value => { brightness = value; writes.push(value); } },
    displayLayoutSetting: { get: () => mode, set: value => { mode = value; }, values: ['small', 'large', 'huge'],
      isDisabled: value => value === 'huge', displayValue(value = mode) { return value[0].toUpperCase() + value.slice(1); } },
    phoneInputStyleSetting: { get: () => style, set: value => { style = value; } },
    glassesModelName: () => 'G2',
    onAnySettingChanged: subscribe(settingListeners),
  };
  // glasses-display-state and glasses-presence are pure, so the real ones load.
  const openedBand = [];
  const activity = {};
  const load = loader({
    global: { isAndroid: android },
    com: { faceclaw: { app: { FaceclawNeuralBand: {
      isAvailable: () => bandAvailable,
      openSettings: current => openedBand.push(current),
    } } } },
  }, {
    '@nativescript/core': { Observable, Application: { android: { foregroundActivity: activity } },
      Dialogs: { action: async () => picked }, Frame: { topmost: () => ({ goBack: () => back.push(true) }) } },
    '../ui/dashboard-settings': settings,
    '../ui/shell/shell': { shell: { getBatteryLevels: () => levels, onBatteryLevelsChanged: subscribe(batteryListeners) } },
    '../native/watch-app-install': { watchAppInstall: { getState: () => watch.state, getSource: () => watch.source,
      onStateChanged: subscribe(watchListeners), openSource: async () => { watch.opened++; return true; } } },
  });
  const { SettingsViewModel } = load('app/phone-ui/settings-view-model.ts');
  const presence = load('app/g2/glasses-presence.ts');
  return { model: new SettingsViewModel(), changes, writes, back, presence, settingListeners, batteryListeners, watch, watchListeners, activity, openedBand,
    setWatch: next => { Object.assign(watch, next); for (const fn of watchListeners) fn(); },
    brightness: () => brightness, mode: () => mode, style: () => style, pick: value => { picked = value; },
    setLevels: next => { levels = { ...NO_LEVELS, ...next }; for (const fn of batteryListeners) fn(); },
    changeElsewhere: fn => { fn({ setBrightness: value => { brightness = value; }, setStyle: value => { style = value; } });
      for (const listener of settingListeners) listener(); } };
}

test('phone settings only show a Neural Band build with a working Android driver', () => {
  const android = fixture(true);
  assert.equal(android.model.neuralBandRowVisibility, 'visible');
  android.model.onNeuralBandSettingsTap();
  assert.deepEqual(android.openedBand, [android.activity]);

  for (const app of [fixture(), fixture(true, false)]) {
    assert.equal(app.model.neuralBandRowVisibility, 'collapse');
    app.model.onNeuralBandSettingsTap();
    assert.deepEqual(app.openedBand, []);
  }
});

test('brightness controls snap manual levels and restore the manual value after Auto', () => {
  const h = fixture();
  h.model.onBrightnessChange({ value: 76 });
  assert.equal(h.brightness(), '80');
  h.model.onBrightnessAutoChange({ value: true });
  assert.equal(h.brightness(), 'auto');
  assert.equal(h.model.brightnessSliderEnabled, false);
  h.model.onBrightnessChange({ value: 10 });
  assert.equal(h.brightness(), 'auto');
  h.model.onBrightnessAutoChange({ value: false });
  assert.equal(h.brightness(), '80');
  h.model.onBrightnessChange({ value: -10 });
  assert.equal(h.brightness(), '2');
  h.model.onBrightnessChange({ value: NaN });
  assert.equal(h.brightness(), '2');
});

test('display-mode picker preserves cancellation and applies the selected mode', async () => {
  const h = fixture();
  h.pick('Cancel'); await h.model.onDisplayModeTap();
  assert.equal(h.mode(), 'small');
  // Unavailable modes (Full Screen beside a side strip) are not offered.
  h.pick('Huge'); await h.model.onDisplayModeTap();
  assert.equal(h.mode(), 'small');
  h.pick('Large'); await h.model.onDisplayModeTap();
  assert.equal(h.mode(), 'large');
  assert.equal(h.model.displayModeLabel, 'Large ▾');
});

test('Phone input style picks the pad, marks the chosen button and explains it', () => {
  const h = fixture();
  assert.match(h.model.watchStyleClass, /segment-button-selected/);
  assert.doesNotMatch(h.model.ringStyleClass, /selected/);
  const watchHint = h.model.phoneInputStyleHint;
  h.model.onWatchStyleTap();
  assert.deepEqual(h.changes, [], 'picking the current style changes nothing');
  h.model.onRingStyleTap();
  assert.equal(h.style(), 'ring');
  assert.match(h.model.ringStyleClass, /segment-button-selected/);
  assert.doesNotMatch(h.model.watchStyleClass, /selected/);
  assert.notEqual(h.model.phoneInputStyleHint, watchHint);
  // Updated at once, without waiting for the store's own (next-tick) notification.
  assert.deepEqual(h.changes.map(change => change[0]), ['watchStyleClass', 'ringStyleClass', 'phoneInputStyleHint']);
});

test('the page follows changes made on the glasses only while it is on screen', () => {
  const h = fixture();
  assert.equal(h.settingListeners.size, 0, 'nothing is subscribed before the page loads');
  h.model.attach(); h.model.attach();
  assert.equal(h.settingListeners.size, 1); assert.equal(h.batteryListeners.size, 1);
  h.changes.length = 0;
  h.changeElsewhere(remote => { remote.setBrightness('auto'); remote.setStyle('ring'); });
  const changed = Object.fromEntries(h.changes);
  assert.equal(changed.brightnessAuto, true);
  assert.equal(changed.brightnessSliderEnabled, false);
  assert.match(changed.ringStyleClass, /segment-button-selected/);
  assert.ok('displayModeLabel' in changed);
  h.model.detach();
  assert.equal(h.settingListeners.size, 0); assert.equal(h.batteryListeners.size, 0);
  // Coming back (an app resume, or returning to the page) catches up.
  h.changeElsewhere(remote => remote.setBrightness('60'));
  h.changes.length = 0; h.model.attach();
  assert.equal(Object.fromEntries(h.changes).brightnessPercent, 60);
  h.model.detach();
});

test('the battery row hides until a level is known and marks charging only over a live link', () => {
  const h = fixture();
  h.model.attach();
  assert.equal(h.model.batteryLineVisibility, 'collapse');
  h.setLevels({ headset: 90, headsetCharging: true, ring: 72 });
  assert.equal(h.model.batteryLine, 'G2 90%  ·  R1 72%');
  assert.equal(h.model.batteryLineVisibility, 'visible');
  h.changes.length = 0;
  h.presence.updateGlassesPresence({ connected: true });
  assert.equal(h.model.batteryLine, 'G2 90% ⚡  ·  R1 72%');
  assert.deepEqual(h.changes.map(change => change[0]), ['batteryLine', 'batteryLineVisibility']);
  h.model.detach();
  h.presence.updateGlassesPresence({ connected: false });
  assert.equal(h.model.batteryLine, 'G2 90% ⚡  ·  R1 72%', 'a detached page is not updated');
  h.model.attach();
  assert.equal(h.model.batteryLine, 'G2 90%  ·  R1 72%');
  h.model.detach();
});

test('the Apple Watch row shows for a paired watch and follows the install', async () => {
  const h = fixture();
  h.model.attach();
  assert.equal(h.model.watchAppRowVisibility, 'collapse', 'no paired watch (and Android): no row');

  h.setWatch({ state: 'not-installed', source: 'watch-app' });
  assert.equal(h.model.watchAppRowVisibility, 'visible');
  assert.equal(h.model.watchAppInstallVisibility, 'visible');
  assert.equal(h.model.watchAppInstalledVisibility, 'collapse');
  assert.match(h.model.watchAppHint, /Available Apps/);
  h.model.onWatchAppInstallTap();
  await null;
  assert.equal(h.watch.opened, 1);

  // The system installed it while the Watch app was in front.
  h.changes.length = 0;
  h.setWatch({ state: 'installed' });
  assert.equal(h.model.watchAppInstallVisibility, 'collapse');
  assert.equal(h.model.watchAppInstalledVisibility, 'visible');
  assert.equal(h.model.watchAppHintVisibility, 'collapse');
  assert.ok(h.changes.some(change => change[0] === 'watchAppInstalledVisibility'));

  // A build from source without the watch app says so, with no button.
  h.setWatch({ state: 'not-installed', source: null });
  assert.equal(h.model.watchAppInstallVisibility, 'collapse');
  assert.equal(h.model.watchAppHintVisibility, 'visible');

  // Off screen it isn't updated; coming back (as from the Watch app) catches up.
  h.model.detach();
  assert.equal(h.watchListeners.size, 0);
  h.watch.state = 'installed';
  assert.equal(h.model.watchAppInstalledVisibility, 'collapse');
  h.model.attach();
  assert.equal(h.model.watchAppInstalledVisibility, 'visible');
  h.model.detach();
});

test('the back arrow pops the settings page', () => {
  const h = fixture();
  h.model.onBackTap();
  assert.deepEqual(h.back, [true]);
});

test('the settings page binds every row the view model serves and is registered for iOS', () => {
  const fs = require('node:fs'), path = require('node:path');
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const xml = read('app/phone-ui/settings-page.xml');
  for (const binding of ['displayModeLabel', 'onDisplayModeTap', 'brightnessAuto', 'onBrightnessAutoChange', 'brightnessPercent',
    'onBrightnessChange', 'brightnessSliderEnabled', 'watchStyleClass', 'ringStyleClass', 'onWatchStyleTap', 'onRingStyleTap',
    'phoneInputStyleHint', 'watchAppRowVisibility', 'watchAppInstalledVisibility', 'watchAppInstallVisibility', 'onWatchAppInstallTap',
    'watchAppHint', 'watchAppHintVisibility', 'batteryLine', 'batteryLineVisibility', 'onBackTap']) {
    assert.ok(xml.includes(`{{ ${binding} }}`), `settings-page.xml binds ${binding}`);
  }
  // iOS skips webpack's automatic page discovery, and loads app.ios.css instead of app.css.
  const register = read('app/phone-ui/onboarding-register.ios.ts');
  assert.match(register, /registerModule\('phone-ui\/settings-page', /);
  assert.match(register, /registerModule\('phone-ui\/settings-page\.xml', /);
  for (const css of ['app/app.css', 'app/app.ios.css']) assert.match(read(css), /@import '\.\/phone-ui\/settings-page\.css';/);
});

test('Phone input style is a stored setting, Watch by default, also offered in the glasses Settings app', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  // The real setting object, over an in-memory settings store.
  const store = new Map(), sandbox = { exports: {}, global: { isIOS: false }, setTimeout: fn => fn(),
    require: id => id.includes('settings-store') ? { onSettingsStoreChanged() {},
      getStringSetting: (key, fallback) => store.get(key) ?? fallback, setStringSetting: (key, value) => store.set(key, value),
      getBooleanSetting: (key, fallback) => store.get(key) ?? fallback, setBooleanSetting: (key, value) => store.set(key, value) }
      : { Layer: class {}, ASSISTANT_MODEL_CHOICES: [] } };
  vm.runInNewContext(ts.transpileModule(read('app/ui/dashboard-settings.ts'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, sandbox);
  const setting = sandbox.exports.phoneInputStyleSetting;
  assert.equal(setting.label, 'Phone input style');
  assert.equal(setting.get(), 'watch');
  assert.deepEqual([...setting.values].map(value => setting.displayValue(value)), ['Watch', 'Ring']);
  setting.set('ring');
  assert.equal(store.get('phone.inputStyle'), 'ring');
  assert.equal(setting.get(), 'ring');
  store.set('phone.inputStyle', 'settings');
  assert.equal(setting.get(), 'watch', 'an unknown stored value reads as the default');

  // The on-glasses Settings app lists it with the other phone-screen settings.
  const menus = read('app/ui/dashboard/settings-menus.ts');
  const section = menus.slice(menus.indexOf('label: "Phone display"'), menus.indexOf('label: "Watch"'));
  assert.match(section, /enumSettingMenuItem\(phoneInputStyleSetting\)/);
});
