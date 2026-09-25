const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { GrayImage } = require('../.test-build/app/graphics/image.js');
const { textInkBounds, textInkHeight, centeredTextY, tightRowHeight } = require('../.test-build/app/ui/metrics.js');
const { Menu } = require('../.test-build/app/ui/menu-core.js');

function load(file) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const context = { exports: {}, require: () => ({}) };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return context.exports;
}
const { BdfFont } = load('app/graphics/bdffont.ts');
const terminus = (size) => BdfFont.parse(fs.readFileSync(path.join(__dirname, `../app/fonts/terminus/ter-u${size}n.bdf`), 'utf8'));
const SIZES = [12, 14, 16, 18, 20, 22, 24];

/** A font whose glyphs sit `leading` px below the line top and end `trim` px above its bottom. */
function leadingFont(lineHeight, leading, trim) {
  const ascent = lineHeight - 3;
  const inkHeight = lineHeight - leading - trim;
  return {
    lineHeight, ascent, descent: 3,
    // bbxY is the ink bottom's height above the baseline (negative below it).
    getGlyph: () => ({ bbxHeight: inkHeight, bbxY: ascent - leading - inkHeight, bbxWidth: 1, bbxX: 0 }),
  };
}

test('Terminus ink fills its line box, so the compact row keeps its 12px pitch of 16', () => {
  for (const size of SIZES) {
    const font = terminus(size);
    assert.deepEqual(textInkBounds(font), { top: 0, bottom: font.lineHeight }, `ter-u${size}n`);
    assert.equal(tightRowHeight(font), font.lineHeight + 4);
  }
  assert.equal(tightRowHeight(terminus(12)), 16);
});

test('ink bounds follow the rendered glyphs, not the line box', () => {
  const font = leadingFont(21, 4, 1);
  assert.deepEqual(textInkBounds(font), { top: 4, bottom: 20 });
  assert.equal(textInkHeight(font), 16);
  assert.equal(tightRowHeight(font), 20);
  // Centered in a 19px box: 3 spare pixels, 1 above; the line top sits 3 above the box to put ink at +1.
  assert.equal(centeredTextY(font, 100, 19), 100 + 1 - 4);
});

test('fonts without glyph access fall back to the line box', () => {
  const font = { lineHeight: 14, ascent: 11, descent: 3 };
  assert.deepEqual(textInkBounds(font), { top: 0, bottom: 14 });
  assert.equal(centeredTextY(font, 10, 20), 13);
});

test('centered text keeps at least a pixel of clearance inside a compact selection box', () => {
  for (const font of [...SIZES.map(terminus), leadingFont(21, 4, 1), leadingFont(17, 0, 2)]) {
    const box = tightRowHeight(font) - 1;
    const offset = centeredTextY(font, 0, box);
    const { top, bottom } = textInkBounds(font);
    assert.ok(offset + top >= 1, `top clearance at lineHeight ${font.lineHeight}`);
    assert.ok(offset + bottom <= box - 1, `bottom clearance at lineHeight ${font.lineHeight}`);
  }
});

test('a selected compact row keeps every inked pixel of its text', () => {
  const label = 'Jgpqy (É|Å) 0189';
  const inked = (image) => image.withDrawsBaked().pixels.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0);
  for (const size of SIZES) {
    const font = terminus(size);
    const reference = new GrayImage(400, 80);
    reference.drawText(font, 0, 20, label, 255);
    const menu = new Menu({
      items: [label],
      rowGap: 1,
      getHeight: () => tightRowHeight(font),
      draw: ({ image, item, x, y, height }) => image.drawText(font, x + 6, centeredTextY(font, y, height), item, 255),
    });
    const page = new GrayImage(420, 120);
    menu.paint(page, { x: 4, y: 4, width: 400, height: 100 }, true);
    const selection = page.draws.find((draw) => draw.presentation);
    assert.ok(selection, `ter-u${size}n selection`);
    assert.equal(inked(selection.source), inked(reference), `ter-u${size}n keeps all ink`);
  }
});
