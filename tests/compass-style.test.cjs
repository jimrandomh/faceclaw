const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, requireModule, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const context = { exports: {}, require: requireModule, ...globals };
  vm.runInNewContext(js, context, { filename: file });
  return context.exports;
}

const textwrap = load('app/graphics/textwrap.ts');
const graphics = load('app/graphics/image.ts', () => textwrap);
const { BdfFont } = load('app/graphics/bdffont.ts', () => ({}));
const font = (size) => BdfFont.parse(fs.readFileSync(
  path.join(__dirname, `../app/fonts/terminus/ter-u${size}n.bdf`), 'utf8'));
const small = font(12);
const large = font(24);

function compass({ style, width = 576, height = 260 } = {}) {
  const settings = new Map(style === undefined ? [] : [['compass.style', style]]);
  let listener;
  let window;
  let renders = 0;
  let pops = 0;
  class RecordingImage extends graphics.GrayImage {
    lines = [];
    texts = [];
    drawLine(...args) { this.lines.push(args); super.drawLine(...args); }
    drawText(font, x, y, text, value) {
      this.texts.push({ x, y, text, value });
      super.drawText(font, x, y, text, value);
    }
  }
  const modules = {
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => small, getDefaultLargeFont: () => large },
    '../../graphics/image': { ...graphics, GrayImage: RecordingImage },
    '../../graphics/textwrap': textwrap,
    '../../native/settings-store': {
      getStringSetting: (key, fallback) => settings.get(key) ?? fallback,
      setStringSetting: (key, value) => settings.set(key, value),
    },
    '../../native/compass': {
      COMPASS_CHANGED: 1, COMPASS_CALIBRATION_STARTED: 2, COMPASS_CALIBRATION_COMPLETE: 3,
      addCompassListener: (fn) => { listener = fn; return () => {}; },
      setCompassEnabled() {},
    },
    '../../ui/metrics': { lineStep: (font) => font.lineHeight + 2 },
    '../../ui/shell/geometry': { screenCenterInViewportX: () => width - 320 },
    '../../ui/shell/in-process-window': {
      YieldAtRootLayer: class { constructor(layer) { return layer; } },
      createInProcessWindow: (options) => { window = options; return { requestRender: () => renders++ }; },
    },
    '../../ui/shell/shell': { shell: { isWindowVisible: () => true } },
    '../../g2/android-permissions': { hasLocationPermission: () => false },
    './calibration': { isCompassCalibrated: () => true, normalizeHeading: (n) => ((n % 360) + 360) % 360 },
    './calibration-layer': {},
    './declination': { onDeclinationChanged: () => () => {} },
    './heading': { getNorthReference: () => 'magnetic', resolveHeading: (n) => ({ displayDegrees: n }) },
  };
  const app = load('app/apps/compass/compass-app.ts', (name) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`);
    return modules[name];
  }, { setInterval: () => 1, clearInterval() {} });
  const ctx = { stack: { getBaseSize: () => ({ width, height }), pop: () => pops++ } };
  const open = () => app.createCompassAppWindow({ onClosed() {} });
  open();
  return {
    settings, open,
    menu: () => window.menuItems(),
    toggle: () => window.menuItems().find((item) => item.label.startsWith('Style:')).onSelect(ctx),
    paint: () => window.baseLayer.paint(ctx),
    heading: (degrees) => listener({ command: 1, headingDegrees: degrees }),
    renders: () => renders,
    pops: () => pops,
  };
}

test('Circle is the default; the context menu switches, repaints and remembers the style', () => {
  const app = compass();
  assert.equal(app.menu()[0].label, 'Style: Circle');
  const before = app.renders();
  app.toggle();
  assert.equal(app.menu()[0].label, 'Style: Strip');
  assert.equal(app.settings.get('compass.style'), 'strip');
  assert.equal(app.renders(), before + 1);
  assert.equal(app.pops(), 1);
  app.open();
  assert.equal(app.menu()[0].label, 'Style: Strip');
  app.toggle();
  assert.equal(app.menu()[0].label, 'Style: Circle');
  assert.equal(compass({ style: 'unknown' }).menu()[0].label, 'Style: Circle');
});

test('switching styles preserves the numeric readout and status at every display size', () => {
  for (const [width, height] of [[576, 260], [576, 452], [640, 452]]) {
    const app = compass({ width, height });
    app.heading(82);
    const circle = app.paint();
    app.toggle();
    const strip = app.paint();
    assert.deepEqual(strip.texts.slice(0, 2), circle.texts);
    assert.deepEqual(circle.texts.map((item) => item.text), ['82° E', 'Magnetic heading']);
  }
});

test('strip ticks are 5 degrees apart on the full-display 23 degree scale', () => {
  for (const width of [576, 640]) {
    const app = compass({ style: 'strip', width });
    app.heading(90);
    const image = app.paint();
    const top = image.lines[0][1];
    const ticks = image.lines.filter(([x0, y0, x1]) => x0 === x1 && y0 === top);
    assert.deepEqual(ticks.map(([x]) => x), [80, 85, 90, 95, 100]
      .map((bearing) => Math.round(width - 320 + (bearing - 90) * 640 / 23))
      .filter((x) => x >= 0 && x < width));
    assert.equal(image.lines[0][0], 0);
    assert.equal(image.lines[0][2], width - 1);
    assert.equal(image.lines[1][1], image.height - 4);
    assert.ok(image.texts.some(({ text }) => text === 'E'));
  }
});

test('bearings scroll continuously through north with wrapped labels', () => {
  const app = compass({ style: 'strip' });
  const northX = (heading) => {
    app.heading(heading);
    const image = app.paint();
    const north = image.texts.find(({ text }) => text === 'N');
    assert.ok(north);
    assert.ok(image.texts.some(({ text }) => text === '355°'));
    assert.ok(image.texts.some(({ text }) => text === '5°'));
    return north.x;
  };
  assert.ok(Math.abs(northX(359.9) - northX(0.1) - 0.2 * 640 / 23) <= 1);
});

test('a strip waiting for sensor data shows the rails without invented bearings', () => {
  const app = compass({ style: 'strip' });
  const image = app.paint();
  assert.deepEqual(image.texts.map(({ text }) => text), ['--°', 'Waiting for compass data…']);
  assert.equal(image.lines.length, 2);
  assert.ok(image.lines[0][4] < 105);
});
