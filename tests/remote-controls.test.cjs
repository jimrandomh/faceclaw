const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function fixture() {
  let brightness = '40', mode = 'small', picked;
  const changes = [], writes = [];
  class Observable {
    notifyPropertyChange(name, value) { changes.push([name, value]); }
  }
  const settings = {
    brightnessSetting: { get: () => brightness, set: value => { brightness = value; writes.push(value); } },
    displayModeSetting: { get: () => mode, set: value => { mode = value; } },
    DISPLAY_MODE_VALUES: ['small', 'large'], displayModeLabel: value => value === 'small' ? 'Small' : 'Large',
  };
  const { RemoteControlsViewModel } = loader({}, {
    '@nativescript/core': { Observable, Dialogs: { action: async () => picked } },
    '../ui/dashboard-settings': settings,
  })('app/phone-ui/remote-controls-view-model.ts');
  return { model: new RemoteControlsViewModel(), create: () => new RemoteControlsViewModel(), changes, writes,
    brightness: () => brightness, mode: () => mode, pick: value => { picked = value; } };
}

test('shared controls preserve the selected tab across page visits and update all tab bindings', () => {
  const h = fixture();
  assert.equal(h.model.watchTabVisibility, 'visible');
  h.model.onRingTabTap();
  assert.equal(h.model.watchTabVisibility, 'collapse');
  assert.equal(h.model.ringTabVisibility, 'visible');
  assert.match(h.model.ringTabClass, /tab-button-selected/);
  assert.equal(h.changes.length, 6);
  assert.equal(h.create().ringTabVisibility, 'visible');
  h.model.onSettingsTabTap();
  assert.equal(h.model.settingsTabVisibility, 'visible');
});

test('shared brightness controls snap manual levels and restore the manual value after Auto', () => {
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

test('shared screen-size picker preserves cancellation and applies the selected mode', async () => {
  const h = fixture();
  h.pick('Cancel'); await h.model.onDisplayModeTap();
  assert.equal(h.mode(), 'small');
  h.pick('Large'); await h.model.onDisplayModeTap();
  assert.equal(h.mode(), 'large');
  assert.equal(h.model.displayModeLabel, 'Large ▾');
});
