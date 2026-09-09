const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, modules = {}, extra = '', globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8') + extra;
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
const { BdfFont } = load('app/graphics/bdffont.ts', { '@nativescript/core': {} });
const graphics = load('app/graphics/image.ts', { './textwrap': textwrap });
const { GrayImage } = graphics;
const font = (size) => BdfFont.parse(fs.readFileSync(
  path.join(__dirname, `../app/fonts/terminus/ter-u${size}n.bdf`), 'utf8'));
const small = font(12);
const large = font(24);
let viewportWidth = 576;
const compass = load('app/apps/compass/compass-app.ts', {
  '../../graphics/ui-fonts': { getDefaultSmallFont: () => small, getDefaultLargeFont: () => large },
  '../../graphics/image': graphics,
  '../../graphics/textwrap': textwrap,
  '../../native/compass': {},
  '../../ui/metrics': { lineStep: (font) => font.lineHeight + 2 },
  '../../ui/shell/geometry': { screenCenterInViewportX: () => viewportWidth - 320 },
  '../../ui/shell/in-process-window': {},
  '../../ui/shell/shell': {},
  '../../g2/android-permissions': {},
  './calibration': { isCompassCalibrated: () => true, normalizeHeading: (n) => ((n % 360) + 360) % 360 },
  './calibration-layer': {},
  './declination': {},
  './heading': { getNorthReference: () => 'magnetic', resolveHeading: (n) => ({ displayDegrees: n }) },
}, `
export { CompassLayer, rotatingRoseBounds, createCompassBackground, drawCompassRose };
export function referenceFrame(width, height, cx, cy, radius, clipY, heading) {
  const image = new GrayImage(width, height, 0);
  const fade = heading === null ? 0.45 : 1;
  drawPlaneGrid(image, cx, cy, radius, clipY);
  drawDiscWall(image, cx, cy, radius, fade);
  drawTiltedRing(image, cx, cy, radius, 105 * fade);
  drawCompassRose(image, cx, cy, radius, heading);
  drawHeadingTick(image, cx, cy, radius, 255 * fade);
  return image;
}
`);

test('rotation bounds contain every painted point through a full turn', () => {
  for (const radius of [24, 60, 98]) {
    const cx = 120;
    const cy = 70.25;
    const bounds = compass.rotatingRoseBounds(cx, cy, radius);
    assert.ok(bounds.width <= 255 && bounds.height <= 255, 'fits a cache image');
    const image = new GrayImage(240, 160, 0);
    // Accumulate the entire sweep, including fractional-degree orientations.
    for (let heading = 0; heading < 360; heading += 0.5) {
      compass.drawCompassRose(image, cx, cy, radius, heading);
    }
    let count = 0;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        if (!image.getPixel(x, y)) continue;
        count++;
        assert.ok(x >= bounds.x && x < bounds.x + bounds.width
          && y >= bounds.y && y < bounds.y + bounds.height, `point outside bounds at ${x},${y}`);
      }
    }
    assert.ok(count > 0);
  }
});

test('cached background preserves the raster and tick layering at every heading', () => {
  for (const [width, height, radius] of [[576, 260, 98], [640, 452, 98], [240, 160, 24]]) {
    const cx = width / 2;
    const cy = height - 65.25;
    for (const heading of [null, ...Array.from({ length: 72 }, (_, i) => i * 5)]) {
      const background = compass.createCompassBackground(width, height, cx, cy, radius, 30, heading === null ? 0.45 : 1);
      const image = background.clone();
      compass.drawCompassRose(image, cx, cy, radius, heading);
      const expected = compass.referenceFrame(width, height, cx, cy, radius, 30, heading);
      assert.deepEqual(image.withDrawsBaked().pixels, expected.pixels, `heading ${heading}, radius ${radius}`);
      assert.equal(image.draws.length, 1);
      const draw = image.draws[0];
      assert.equal(draw.kind, 'image');
      assert.equal(draw.source.hasDeferredDraws(), false);
      const bounds = compass.rotatingRoseBounds(cx, cy, radius);
      assert.deepEqual({ x: draw.x, y: draw.y, width: draw.source.width, height: draw.source.height }, { ...bounds });
      // Every nonzero texture pixel must match the final composite, as the
      // wire planner requires before it can replay a cached image.
      for (let y = 0; y < draw.source.height; y++) {
        for (let x = 0; x < draw.source.width; x++) {
          const value = draw.source.getPixel(x, y);
          if (value) assert.equal(value, expected.getPixel(draw.x + x, draw.y + y));
        }
      }
    }
  }
});

test('heading updates reuse the texture; brightness, layout and clipping changes rebuild it', () => {
  const layer = new compass.CompassLayer(() => {});
  layer.enabled = true;
  let height = 260;
  const ctx = { stack: { getBaseSize: () => ({ width: viewportWidth, height }) } };
  const texture = () => layer.paint(ctx).draws.find((draw) => draw.kind === 'image').source;
  const waiting = texture();
  layer.rawHeading = 0;
  const initial = texture();
  assert.notEqual(initial, waiting);
  const snapshot = initial.pixels.slice();
  for (const heading of [1, 45, 180, 359.9, 0]) {
    layer.rawHeading = heading;
    assert.equal(texture(), initial);
  }
  assert.deepEqual(initial.pixels, snapshot, 'shared texture remains immutable');
  height = 452;
  const tall = texture();
  assert.notEqual(tall, initial);
  viewportWidth = 640;
  const wide = texture();
  assert.notEqual(wide, tall);
  layer.firmwareStatus = 'Calibration status '.repeat(12);
  assert.notEqual(texture(), wide);
  viewportWidth = 576;
});

test('the background registers once and uses a nine-byte image reference on later frames', () => {
  const registered = [];
  const { prepareFrameDraws } = load('app/graphics/glyph-wire.ts', {}, '', {
    global: { isAndroid: true },
    com: { faceclaw: { app: { ImageAtlas: { ensure: (...args) => {
      registered.push(args);
      return 1;
    } } } } },
  });
  const background = compass.createCompassBackground(576, 260, 256, 193.25, 98, 140, 1);
  for (const heading of [0, 1, 2, 45, 90]) {
    const image = background.clone();
    compass.drawCompassRose(image, 256, 193.25, 98, heading);
    const buffer = prepareFrameDraws(image.draws);
    assert.equal(buffer.byteLength, 9);
    assert.equal(new DataView(buffer).getUint8(0), 1);
  }
  assert.equal(registered.length, 1);
});
