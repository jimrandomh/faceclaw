const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, modules) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const context = { exports: {}, console, require(name) { assert.ok(name in modules, `${file}: ${name}`); return modules[name]; } };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return context.exports;
}

const build = (name) => require(`../.test-build/app/${name}.js`);
const graphics = build('graphics/image');
const metrics = build('ui/metrics');
const { BdfFont } = load('app/graphics/bdffont.ts', { '@nativescript/core': {} });
const bdf = (size) => BdfFont.parse(fs.readFileSync(path.join(__dirname, `../app/fonts/terminus/ter-u${size}n.bdf`), 'utf8'));
const font = bdf(14);
const textwrap = load('app/graphics/textwrap.ts', {});
const coreDeps = {
  '../graphics/image': graphics, './menu-highlight-motion': build('ui/menu-highlight-motion'),
  '../graphics/menu-scroll-list': build('graphics/menu-scroll-list'), './menu-scroll-motion': build('ui/menu-scroll-motion'),
  '../graphics/draw-expression': build('graphics/draw-expression'),
};
const menuCore = load('app/ui/menu-core.ts', coreDeps);
const menu = load('app/ui/menu.ts', {
  ...coreDeps, './menu-animation-pref': build('ui/menu-animation-pref'), './animation-speed': build('ui/animation-speed'),
  '../native/settings-store': { getStringSetting: (_key, fallback) => fallback },
  '../graphics/screen-size': { screenWidth: () => 540, screenHeight: () => 220 },
  '../graphics/textwrap': textwrap, '../graphics/ui-fonts': { getDefaultSmallFont: () => font },
  '../util/numeric-util': { clamp: (n, lo, hi) => Math.max(lo, Math.min(hi, n)) }, './gestures': {}, './metrics': metrics, './menu-core': menuCore,
});
// The UI font picker on Roboto Light 20, drawn in Terminus (TTF rendering is native).
const preview = bdf(20);
const picker = load('app/ui/font-picker.ts', {
  '../graphics/bdffont': { getFont: () => font }, '../graphics/image': graphics, '../graphics/textwrap': textwrap,
  '../graphics/ttf-font': { TtfFont: { load: () => preview } },
  '../graphics/installed-fonts': { listInstalledFonts: () => [{ path: '/fonts/Roboto-Light.ttf', fileName: 'Roboto-Light.ttf',
    family: 'Roboto', style: 'Light', weightOrder: 300, monospace: false }] },
  '../graphics/ui-fonts': { fontSelectionLabel: () => 'Roboto Light 20', getDefaultSmallFont: () => font, uiFontSizeAllowed: () => true,
    getTerminalFontSelection: () => null, getUiFontSelection: () => ({ kind: 'ttf', file: 'Roboto-Light.ttf', size: 20 }),
    setTerminalFontSelection() {}, setUiFontSelection() {} },
  './gestures': {}, './menu': menu, './menu-core': menuCore, './metrics': metrics,
});

function stackOf(size) {
  const layers = [];
  return { layers, ctx: { stack: { getBaseSize: () => size, isFocused: () => true, push: (layer) => layers.push(layer) } } };
}
const glyphRuns = (image, f) => image.draws.filter((d) => d.kind === 'glyph' && d.font === f);

test('the font picker previews under its rows where they fit, else beside them, on the window either way', () => {
  // At 192 rows either fits, by the font's metrics: only the bounds are checked.
  for (const [size, beside] of [[{ width: 576, height: 260 }, false], [{ width: 476, height: 192 }, null], [{ width: 476, height: 155 }, true]]) {
    const { layers, ctx } = stackOf(size);
    picker.uiFontPickerMenuItem().onSelect(ctx);
    const image = layers[0].paint(ctx);
    const sample = glyphRuns(image, preview);
    // The rows' labels and values (255 selected, 200 not; the title is 220, the info line 110).
    const rows = glyphRuns(image, font).filter((d) => d.value === 255 || d.value === 200);
    assert.ok(sample.length > 20, `the sample is drawn at ${size.height}`);
    for (const d of image.draws) {
      if (d.kind !== 'glyph') continue;
      assert.ok(d.x >= 0 && d.y >= 0 && d.x + d.glyph.bbxWidth <= size.width && d.y + d.font.lineHeight <= size.height,
        `glyph at ${d.x},${d.y} outside ${size.width}x${size.height}`);
    }
    const rowsRight = Math.max(...rows.map((d) => d.x)), rowsBottom = Math.max(...rows.map((d) => d.y));
    if (beside === true) assert.ok(Math.min(...sample.map((d) => d.x)) > rowsRight, 'the sample right of the rows');
    if (beside === false) assert.ok(Math.min(...sample.map((d) => d.y)) > rowsBottom, 'the sample under the rows');
  }
});

test('a modal menu in a short window (a RayNeo iO\'s) keeps narrow margins, so four choices all show', () => {
  const items = ['Left', 'Right', 'Bottom', 'Popup'].map((label) => ({ label, onSelect() {} }));
  for (const [size, margin] of [[{ width: 576, height: 260 }, 20], [{ width: 476, height: 155 }, 8]]) {
    const { layers, ctx } = stackOf(size);
    menu.openModalMenu(ctx, 'App switcher position', items, 0);
    const { layout } = layers[0];
    assert.ok(layout.y >= margin && layout.y + layout.maxHeight <= size.height - margin, `${size.height}: ${layout.y}+${layout.maxHeight}`);
    // Title, body padding (8 above and below) and the four rows.
    const natural = metrics.menuTitleHeight(font) + 2 * 8 + items.length * metrics.listRowHeight(font);
    assert.equal(layout.maxHeight, natural, `${size.height}: every row fits`);
  }
});
