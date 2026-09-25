const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBrightnessCurve, brightnessCurveError, DEFAULT_BRIGHTNESS_CURVE } = require('../.test-build/app/g2/brightness-curve.js');
test('brightness curve accepts monotone knots and canonicalizes spacing', () => {
  assert.equal(normalizeBrightnessCurve(' 0:0, 2.5:20,1000:100 '), '0:0,2.5:20,1000:100');
});
test('invalid brightness drafts survive editing and report an error', () => {
  for (const text of ['', '0:0', '1:0,100:100', '0:0,1:80,2:50,3:100', '0:0,0:100', '0:0,NaN:100', '0:0,1:99', '0:0,1e9:100', ':0,1:100']) {
    assert.equal(normalizeBrightnessCurve(text), text);
    assert.ok(brightnessCurveError(text), text);
  }
});

test('only the previous default migrates to the calibrated curve', () => {
  assert.equal(normalizeBrightnessCurve('0:0,1:10,10:30,100:65,1000:100'), DEFAULT_BRIGHTNESS_CURVE);
  assert.equal(normalizeBrightnessCurve('0:0,3:50,10:100'), '0:0,3:50,10:100');
});

const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
function settingsFixture(store = new Map()) {
  const context = { exports: {}, global: { isIOS: false }, require: id => {
    if (id.includes('settings-store')) return {
      onSettingsStoreChanged() {}, getStringSetting: (k, d) => store.get(k) ?? d,
      setStringSetting: (k, v) => store.set(k, v),
    };
    if (id.includes('brightness-curve')) return require('../.test-build/app/g2/brightness-curve.js');
    return { Layer: class {}, ASSISTANT_MODEL_CHOICES: [] };
  }};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/ui/dashboard-settings.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return context.exports;
}
test('auto minimum defaults to 20 and preserves a saved preference', () => {
  assert.equal(settingsFixture().getBrightnessPreferences().minimum, 20);
  assert.equal(settingsFixture(new Map([['display.autoBrightnessMin', '25']])).getBrightnessPreferences().minimum, 25);
});
test('curve drafts preview exactly while brightness keeps the previous valid saved curve', () => {
  const store = new Map([['display.autoBrightnessCurve', '0:0,2:50,8:100']]);
  let api = settingsFixture(store), curve = api.autoBrightnessCurveSetting;
  assert.equal(api.getBrightnessPreferences().minimum, 20);
  curve.set('0:0,2:50,8:');
  assert.equal(curve.get(), '0:0,2:50,8:');
  assert.ok(curve.validationError());
  assert.equal(api.getBrightnessPreferences().curve, '0:0,2:50,8:100');
  // Restart keeps the draft and the last accepted curve separate.
  api = settingsFixture(store); curve = api.autoBrightnessCurveSetting;
  assert.equal(curve.get(), '0:0,2:50,8:');
  assert.equal(api.getBrightnessPreferences().curve, '0:0,2:50,8:100');
  curve.set('0:0,2:50,6:100');
  assert.equal(curve.validationError(), null);
  assert.equal(api.getBrightnessPreferences().curve, '0:0,2:50,6:100');
});
