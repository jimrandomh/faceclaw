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
const graphics = load('app/graphics/image.ts', { './textwrap': textwrap });
const { BdfFont } = load('app/graphics/bdffont.ts', { '@nativescript/core': {} });
const font = (size) => BdfFont.parse(fs.readFileSync(path.join(__dirname, `../app/fonts/terminus/ter-u${size}n.bdf`), 'utf8'));
const small = font(18), large = font(32);
const diagnostics = { magneticAccuracy: 3, magneticAnomalies: 2, orientationSource: 3, flags: 0x8c, sampleTimeMs: 1234 };

function compass(width = 576, height = 260) {
  const settings = new Map();
  const debug = load('app/apps/compass/debug.ts', { '../../native/settings-store': {
    getBooleanSetting: (key, fallback) => settings.get(key) ?? fallback,
    setBooleanSetting: (key, value) => settings.set(key, value),
  } });
  let listener, window, renders = 0, pops = 0;
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
      createInProcessWindow: (options) => { window = options; return { requestRender: () => ++renders }; },
    },
    '../../ui/shell/shell': { shell: { isWindowVisible: () => true } },
    '../../g2/android-permissions': { hasLocationPermission: () => false },
    './calibration': calibration,
    './calibration-layer': {}, './declination': { onDeclinationChanged: () => () => {} },
    './heading': { getNorthReference: () => 'magnetic', resolveHeading: (v) => ({ displayDegrees: v }) },
    './debug': debug,
  }, { setInterval: () => 1, clearInterval() {} });
  const ctx = { stack: { getBaseSize: () => ({ width, height }), pop: () => ++pops } };
  const open = () => app.createCompassAppWindow({ onClosed() {} }); open();
  return { open, debug, settings, menu: () => window.menuItems(),
    toggle: () => window.menuItems().find((item) => item.label.startsWith('Debug information:')).onSelect(ctx),
    paint: () => window.baseLayer.paint(ctx),
    heading: (info) => listener({ command: 15, headingDegrees: 359, diagnostics: info }),
    renders: () => renders, pops: () => pops };
}

test('debug toggle defaults off, repaints, closes menu and survives reopening', () => {
  const app = compass(); app.heading(diagnostics);
  assert.equal(app.debug.isCompassDebugEnabled(), false);
  assert.ok(!app.paint().texts.some((t) => t.text.startsWith('Mag:')));
  const before = app.renders(); app.toggle();
  assert.equal(app.debug.isCompassDebugEnabled(), true);
  assert.ok(app.renders() > before && app.pops() === 1);
  app.open(); assert.equal(app.debug.isCompassDebugEnabled(), true);
  app.toggle(); assert.equal(app.debug.isCompassDebugEnabled(), false);
});

test('diagnostics sit to the right of the heading without overlap or clipping', () => {
  for (const width of [240, 320, 576, 640]) {
    const app = compass(width); app.toggle(); app.heading(diagnostics);
    const image = app.paint();
    const heading = image.texts.find((t) => t.text === '359° N');
    for (const text of ['Mag: 3/3', 'Anom: 2', 'Src: RV']) {
      const label = image.texts.find((t) => t.text === text);
      assert.ok(label, text);
      assert.ok(label.x > heading.x + heading.width);
      assert.ok(label.x + label.width <= width && label.y + label.height <= image.height);
    }
    const status = image.texts.find((t) => t.text === 'Magnetic heading');
    assert.ok(image.texts.filter((t) => t.text.startsWith('Src:')).every((t) => t.y + t.height < status.y));
    if (process.env.COMPASS_PREVIEW && width === 576) {
      fs.writeFileSync(process.env.COMPASS_PREVIEW, Buffer.concat([
        Buffer.from(`P5\n${image.width} ${image.height}\n255\n`), Buffer.from(image.withDrawsBaked().pixels),
      ]));
    }
  }
});

test('legacy and missing samples replace diagnostics instead of leaving stale values', () => {
  const app = compass(); app.toggle(); app.heading(diagnostics);
  assert.ok(app.paint().texts.some((t) => t.text === 'Mag: 3/3'));
  app.heading(undefined);
  assert.ok(app.paint().texts.some((t) => t.text === 'unavailable'));
  assert.ok(!app.paint().texts.some((t) => t.text === 'Mag: 3/3'));
  assert.deepEqual(Array.from(app.debug.compassDebugLines({ ...diagnostics, flags: 0 })), ['Sample data', 'unavailable']);
  for (const [source, name] of [[1, 'GRV'], [2, 'GMRV'], [3, 'RV']]) {
    assert.equal(app.debug.compassDebugLines({ ...diagnostics, orientationSource: source })[2], `Src: ${name}`);
  }
});
