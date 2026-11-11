const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { bordered, unbordered, edged } = require('./helpers/viewport.cjs');

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

function compass(width = 576, height = 260, glasses = 'g2', viewport = bordered(width, height)) {
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
    '../../ui/dashboard-settings': { glassesHaveCompass: () => glasses === 'g2' },
    './calibration': calibration,
    './calibration-layer': {}, './declination': { onDeclinationChanged: () => () => {} },
    './heading': { getNorthReference: () => 'magnetic', resolveHeading: (v) => ({ displayDegrees: v }) },
  }, { setInterval: () => 1, clearInterval() {} });
  const ctx = { stack: { getBaseSize: () => viewport, pop() {} } };
  app.createCompassAppWindow({ onClosed() {} });
  return { menu: () => window.menuItems(),
    paint: () => window.baseLayer.paint(ctx),
    tap: () => window.baseLayer.handleInput({ type: 'click' }, ctx),
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
  for (const [width, height] of [[240, 260], [320, 260], [576, 260], [640, 260], [576, 288], [576, 140], [476, 155]]) {
    for (const viewport of [bordered(width, height), unbordered(width, height), edged(width, height, 'top', 'left'), edged(width, height, 'bottom')]) {
      const where = `${width}x${height} ${JSON.stringify(viewport.padding)}`;
      const app = compass(width, height, 'g2', viewport); app.heading({ ...diagnostics, magneticAccuracy: 2 });
      const image = app.paint();
      const label = calibrationText(image);
      const { padding } = viewport;
      // Every line of text keeps inside the padding of the window's edges.
      for (const text of image.texts) {
        assert.ok(text.x >= padding.left && text.y >= padding.top, `${where}: "${text.text}"`);
        assert.ok(text.x + text.width <= width - padding.right && text.y + text.height <= height - padding.bottom, `${where}: "${text.text}"`);
      }
      for (const other of image.texts.filter((t) => t !== label)) {
        assert.ok(!overlaps(label, other), `${where}: overlaps "${other.text}"`);
      }
      if (process.env.COMPASS_PREVIEW && width === 576 && height === 260 && viewport.padding.top && viewport.padding.right) {
        fs.writeFileSync(process.env.COMPASS_PREVIEW, Buffer.concat([
          Buffer.from(`P5\n${image.width} ${image.height}\n255\n`), Buffer.from(image.withDrawsBaked().pixels),
        ]));
      }
    }
  }
});

test('the calibration readout sits in the top-right corner, at the padding of those edges', () => {
  const corner = (viewport) => {
    const label = calibrationText(compass(576, 260, 'g2', viewport).paint());
    return [label.x + label.width, label.y];
  };
  assert.deepEqual(corner(bordered(576, 260)), [568, 8]);
  assert.deepEqual(corner(unbordered(576, 260)), [576, 0]);
  assert.deepEqual(corner(edged(576, 260, 'top')), [576, 8]);
});

test('glasses without a magnetometer say so and offer no calibration', () => {
  const app = compass(576, 260, 'g1');
  const image = app.paint();
  assert.ok(image.texts.some((t) => t.text === 'These glasses have no compass sensor'));
  assert.equal(calibrationText(image), undefined);
  assert.equal(app.menu().length, 0);
  // ctx.stack has no push or topMatches here, so opening calibration would throw.
  app.tap();
});
