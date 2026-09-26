const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, modules = {}, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const context = { exports: {}, require: (name) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`);
    return modules[name];
  }, ...globals };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context, { filename: file });
  return context.exports;
}
const textwrap = load('app/graphics/textwrap.ts');
const graphics = require('../.test-build/app/graphics/image.js');
const { BdfFont } = load('app/graphics/bdffont.ts', { '@nativescript/core': {} });
const font = (size) => BdfFont.parse(fs.readFileSync(path.join(__dirname, `../app/fonts/terminus/ter-u${size}n.bdf`), 'utf8'));
const small = font(18), large = font(32);
const diagnostics = { magneticAccuracy: 3, magneticAnomalies: 2, orientationSource: 3, flags: 0x8c, sampleTimeMs: 1234 };

function compass(width = 576, height = 260) {
  let listener, window;
  class RecordingImage extends graphics.GrayImage {
    texts = [];
    drawText(font, x, y, text, value) {
      this.texts.push({ x, y, text, width: font.measureText(text), height: font.lineHeight });
      super.drawText(font, x, y, text, value);
    }
  }
  // GrayImage.clone returns the base class; retain text recording for main-screen paints.
  const baseClone = RecordingImage.prototype.clone;
  RecordingImage.prototype.clone = function () {
    const image = baseClone.call(this); Object.setPrototypeOf(image, RecordingImage.prototype); image.texts = []; return image;
  };
  const calibration = { isCompassCalibrated: () => true, normalizeHeading: (v) => v };
  const rose = load('app/apps/compass/compass-rose.ts', {
    '../../graphics/image': { GrayImage: RecordingImage }, './calibration': calibration,
  });
  const app = load('app/apps/compass/compass-app.ts', {
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => small, getDefaultLargeFont: () => large },
    '../../graphics/image': { GrayImage: RecordingImage }, '../../graphics/textwrap': textwrap,
    './compass-rose': rose,
    '../../native/compass': { COMPASS_CHANGED: 15, COMPASS_CALIBRATION_STARTED: 16, COMPASS_CALIBRATION_COMPLETE: 17,
      addCompassListener: (fn) => { listener = fn; return () => {}; }, setCompassEnabled() {} },
    '../../ui/metrics': { lineStep: (font) => font.lineHeight + 2 },
    '../../ui/shell/geometry': { screenCenterInViewportX: () => width / 2 - 32 },
    '../../ui/shell/in-process-window': {
      YieldAtRootLayer: class { constructor(layer) { return layer; } },
      createInProcessWindow: (options) => { window = options; return { requestRender() {} }; },
    },
    '../../ui/shell/shell': { shell: { isWindowVisible: () => true } },
    '../../native/location-permissions': { hasLocationPermission: () => false },
    './calibration': calibration,
    './calibration-layer': {}, './declination': { onDeclinationChanged: () => () => {} },
    './heading': { getNorthReference: () => 'magnetic', resolveHeading: (v) => ({ displayDegrees: v }) },
  }, { setInterval: () => 1, clearInterval() {} });
  const ctx = { stack: { getBaseSize: () => ({ width, height }), pop() {} } };
  app.createCompassAppWindow({ onClosed() {} });
  return { menu: () => window.menuItems(),
    paint: () => window.baseLayer.paint(ctx),
    heading: (info) => listener({ command: 15, headingDegrees: 359, diagnostics: info }) };
}

const calibrationText = (image) => image.texts.find((t) => t.text.startsWith('Calibration:'));
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('calibration readiness is always shown and the debug toggle is gone', () => {
  const app = compass();
  assert.ok(!app.menu().some((item) => item.label.startsWith('Debug information')));
  assert.equal(calibrationText(app.paint()).text, 'Calibration: --');
  app.heading(diagnostics);
  assert.equal(calibrationText(app.paint()).text, 'Calibration: ●●●');
  assert.ok(!app.paint().texts.some((t) => /^(Mag|Anom|Src):/.test(t.text)));
});

test('calibration dots track firmware magnetic accuracy and never go stale', () => {
  const app = compass();
  for (const [accuracy, dots] of [[0, '○○○'], [1, '●○○'], [2, '●●○'], [3, '●●●'], [4, '●●●'], [-1, '--']]) {
    app.heading({ ...diagnostics, magneticAccuracy: accuracy });
    assert.equal(calibrationText(app.paint()).text, `Calibration: ${dots}`, `accuracy ${accuracy}`);
  }
  app.heading(diagnostics);
  // Legacy samples (no 0x80 flag) and missing diagnostics must replace the old value.
  app.heading({ ...diagnostics, flags: 0 });
  assert.equal(calibrationText(app.paint()).text, 'Calibration: --');
  app.heading(diagnostics);
  app.heading(undefined);
  assert.equal(calibrationText(app.paint()).text, 'Calibration: --');
});

test('calibration readout fits the viewport without overlapping the heading or status', () => {
  for (const [width, height] of [[240, 260], [320, 260], [576, 260], [640, 260], [576, 288], [576, 140]]) {
    const app = compass(width, height); app.heading({ ...diagnostics, magneticAccuracy: 2 });
    const image = app.paint();
    const label = calibrationText(image);
    assert.ok(label.x >= 0 && label.y >= 0, `${width}x${height}`);
    assert.ok(label.x + label.width <= width && label.y + label.height <= image.height, `${width}x${height}`);
    for (const other of image.texts.filter((t) => t !== label)) {
      assert.ok(!overlaps(label, other), `${width}x${height}: overlaps "${other.text}"`);
    }
    if (process.env.COMPASS_PREVIEW && width === 576 && height === 260) {
      fs.writeFileSync(process.env.COMPASS_PREVIEW, Buffer.concat([
        Buffer.from(`P5\n${image.width} ${image.height}\n255\n`), Buffer.from(image.withDrawsBaked().pixels),
      ]));
    }
  }
});
