const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');

// dashboard-settings.ts over an in-memory settings store (as in brightness-curve.test.cjs).
function settingsFixture(store = new Map()) {
  const context = { exports: {}, global: { isIOS: false }, require: id => {
    if (id.includes('settings-store')) return {
      onSettingsStoreChanged() {}, getStringSetting: (k, d) => store.get(k) ?? d,
      setStringSetting: (k, v) => store.set(k, v),
      getBooleanSetting: (k, d) => store.get(k) ?? d, setBooleanSetting: (k, v) => store.set(k, v),
    };
    if (id.includes('brightness-curve')) return require('../.test-build/app/g2/brightness-curve.js');
    if (id.includes('animation-speed')) return require('../.test-build/app/ui/animation-speed.js');
    return { Layer: class {}, ASSISTANT_MODEL_CHOICES: [] };
  }};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/ui/dashboard-settings.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return context.exports;
}

test('the display mode starts as the middle band, or carries over the old mode and vertical position', () => {
  const layout = (entries) => settingsFixture(new Map(entries)).displayLayoutSetting.get();
  assert.equal(layout([]), 'band-middle');
  assert.equal(layout([['display.verticalPosition', 'upper']]), 'band-high');
  assert.equal(layout([['display.mode', '576x288'], ['display.verticalPosition', 'lower']]), 'band-low');
  assert.equal(layout([['display.mode', '576x480'], ['display.verticalPosition', 'top']]), 'tall');
  assert.equal(layout([['display.mode', '640x480']]), 'fullscreen');
  // Once set, the merged setting is its own.
  const store = new Map([['display.mode', '576x480']]);
  const api = settingsFixture(store);
  api.displayLayoutSetting.set('band-bottom');
  assert.equal(store.get('display.layout'), 'band-bottom');
  assert.equal(api.displayLayoutSetting.get(), 'band-bottom');
});

test('per-app display modes carry over their old mode and position where the merged values can say it', () => {
  const app = (appId, entries) => settingsFixture(new Map(entries))[`${appId}DisplayLayoutSetting`].get();
  assert.equal(app('navigate', []), 'global');
  assert.equal(app('terminal', []), 'default');
  assert.equal(app('navigate', [['navigate.displayMode', '576x288'], ['navigate.verticalPosition', 'bottom']]), 'band-bottom');
  // A band at the global position takes the global band.
  assert.equal(app('navigate', [['navigate.displayMode', '576x288'], ['display.verticalPosition', 'top']]), 'band-top');
  assert.equal(app('navigate', [['navigate.displayMode', '576x288'], ['display.layout', 'band-low']]), 'band-low');
  // Following the global band at a position of its own.
  assert.equal(app('navigate', [['navigate.verticalPosition', 'top']]), 'band-top');
  assert.equal(app('navigate', [['navigate.verticalPosition', 'top'], ['display.mode', '576x480']]), 'global');
  assert.equal(app('terminal', [['terminal.displayMode', '640x480']]), 'fullscreen');
  assert.equal(app('terminal', [['terminal.displayMode', 'global']]), 'global');
  assert.equal(app('terminal', [['terminal.verticalPosition', 'lower']]), 'default');
});

test('Full Screen is offered only with a bottom or popup app switcher', () => {
  const store = new Map();
  const api = settingsFixture(store);
  for (const [position, available] of [['left', false], ['right', false], ['bottom', true], ['popup', true]]) {
    api.appSwitcherPositionSetting.set(position);
    assert.equal(api.fullScreenAvailable(), available, position);
    assert.equal(api.displayLayoutSetting.isDisabled('fullscreen'), !available, position);
    assert.equal(api.navigateDisplayLayoutSetting.isDisabled('fullscreen'), !available, position);
    assert.equal(api.displayLayoutSetting.isDisabled('tall'), false);
  }
  assert.deepEqual(Array.from(api.DISPLAY_LAYOUT_VALUES, (value) => api.displayLayoutLabel(value)),
    ['Band · Top', 'Band · High', 'Band · Middle', 'Band · Low', 'Band · Bottom', 'Tall', 'Full Screen']);
});
