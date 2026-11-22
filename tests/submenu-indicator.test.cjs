const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, modules) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const context = { exports: {}, console, require(name) { assert.ok(name in modules, name); return modules[name]; } };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return context.exports;
}

const graphics = require('../.test-build/app/graphics/image.js');
const { GrayImage } = graphics;
const { BdfFont } = load('app/graphics/bdffont.ts', { '@nativescript/core': {} });
const terminus12 = BdfFont.parse(fs.readFileSync(path.join(__dirname, '../app/fonts/terminus/ter-u12n.bdf'), 'utf8'));
/** Stands in for the default TTF (Roboto Light 16), which needs the native renderer. */
const largeFont = { lineHeight: 19 };
const { drawSubmenuIndicator, submenuItem } = load('app/ui/menu.ts', {
  './menu-animation-pref': require('../.test-build/app/ui/menu-animation-pref.js'), './animation-speed': require('../.test-build/app/ui/animation-speed.js'),
  '../native/settings-store': { getStringSetting: (_key, fallback) => fallback }, '../graphics/screen-size': { screenWidth: () => 640, screenHeight: () => 480 },
  '../graphics/image': graphics, '../graphics/textwrap': load('app/graphics/textwrap.ts', {}), '../graphics/ui-fonts': { getDefaultSmallFont: () => terminus12 },
  '../util/numeric-util': { clamp: (n, lo, hi) => Math.max(lo, Math.min(hi, n)) }, './gestures': {},
  './metrics': require('../.test-build/app/ui/metrics.js'), './menu-core': require('../.test-build/app/ui/menu-core.js'),
});

/** The indicator's one deferred draw in a 100x40 image, for a row rect at (10, 8) sized 80xheight. */
function indicator(font, value, height = 25) {
  const image = new GrayImage(100, 40, 0);
  drawSubmenuIndicator(image, font, 10, 8, 80, height, value);
  assert.equal(image.draws.length, 1);
  return { image, draw: image.draws[0] };
}

function rows(source) {
  return Array.from({ length: source.height }, (_unused, y) =>
    [...source.pixels.subarray(y * source.width, (y + 1) * source.width)]);
}

test('the submenu indicator is an image, not a glyph from a fallback font', () => {
  const { draw } = indicator(largeFont, 255);
  assert.equal(draw.kind, 'image');
  assert.equal(draw.presentation, undefined);
  assert.deepEqual(rows(draw.source), [
    [191, 64, 0, 0, 0, 0, 0, 0, 0, 0],
    [255, 255, 191, 64, 0, 0, 0, 0, 0, 0],
    [255, 255, 255, 255, 191, 64, 0, 0, 0, 0],
    [255, 255, 255, 255, 255, 255, 191, 64, 0, 0],
    [255, 255, 255, 255, 255, 255, 255, 255, 191, 64],
    [255, 255, 255, 255, 255, 255, 255, 255, 191, 64],
    [255, 255, 255, 255, 255, 255, 191, 64, 0, 0],
    [255, 255, 255, 255, 191, 64, 0, 0, 0, 0],
    [255, 255, 191, 64, 0, 0, 0, 0, 0, 0],
    [191, 64, 0, 0, 0, 0, 0, 0, 0, 0],
  ]);
});

test('the triangle sits 4px inside the right edge, centered with a spare pixel above', () => {
  const { draw } = indicator(largeFont, 255, 25);
  // Rect x 10..90: the 10px triangle ends at 86. Rect y 8..33: 8 rows above, 7 below.
  assert.deepEqual([draw.x, draw.y], [76, 16]);
  const fractional = new GrayImage(100, 40, 0);
  drawSubmenuIndicator(fractional, largeFont, 10.4, 8, 79.8, 25, 255);
  assert.deepEqual([fractional.draws[0].x, fractional.draws[0].y], [76, 16]);
});

test('small fonts get the small triangle, where the 12px bitmap glyph was', () => {
  const { draw } = indicator(terminus12, 255, 18);
  assert.deepEqual(rows(draw.source), [
    [191, 64, 0, 0, 0, 0],
    [255, 255, 191, 64, 0, 0],
    [255, 255, 255, 255, 191, 64],
    [255, 255, 255, 255, 191, 64],
    [255, 255, 191, 64, 0, 0],
    [191, 64, 0, 0, 0, 0],
  ]);
  // Terminus's own glyph: 6 wide ending 4px inside the rect, on rows 6..11 of an 18-row box.
  assert.deepEqual([draw.x, draw.y], [80, 14]);
});

test('the triangle takes the brightness of the row text, one cached image per brightness', () => {
  const dim = indicator(largeFont, 70).draw.source;
  assert.deepEqual(rows(dim)[4], [70, 70, 70, 70, 70, 70, 70, 70, 52, 18]);
  assert.equal(indicator(largeFont, 70).draw.source, dim);
  assert.notEqual(indicator(largeFont, 200).draw.source, dim);
  assert.equal(indicator(largeFont, 200).draw.source, indicator(largeFont, 200).draw.source);
});

test('a submenu row bakes to its label plus the triangle', () => {
  const row = new GrayImage(120, 18, 0);
  submenuItem('Animations', () => {}).render({ image: row, x: 0, y: 0, width: 120, height: 18, selected: true, disabled: false, text: 'Animations' });
  assert.deepEqual(row.draws.filter(draw => draw.kind === 'image').map(draw => [draw.x, draw.y]), [[110, 6]]);
  const baked = row.withDrawsBaked();
  // The triangle's widest rows, at full brightness for a selected row.
  assert.deepEqual([...baked.pixels.subarray(8 * 120 + 110, 8 * 120 + 116)], [255, 255, 255, 255, 191, 64]);
  assert.deepEqual([...baked.pixels.subarray(9 * 120 + 110, 9 * 120 + 116)], [255, 255, 255, 255, 191, 64]);
});
