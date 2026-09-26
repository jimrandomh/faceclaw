const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const build = (name) => require(`../.test-build/app/${name}.js`);
const metrics = build('ui/metrics');
const { GrayImage } = build('graphics/image');
const { DrawOp } = build('graphics/display-list');
const { MENU_HIGHLIGHT_DURATION_MS } = build('ui/menu-highlight-motion');
const { MENU_BOUNCE_DURATION_MS } = build('ui/menu-scroll-motion');

const LINE_HEIGHT = 21;
// icon 44 + label gap 2 + line 21 + 8 breathing room.
const ROW_H = 75;

/** A font whose every glyph is a 4x6 block, drawn as deferred glyph draws like a real atlas font. */
function stubFont() {
  const glyphs = new Map();
  const glyph = (cp) => {
    if (!glyphs.has(cp)) glyphs.set(cp, { encoding: cp, bbxWidth: 4, bbxHeight: 6, bbxX: 0, bbxY: 0, bitmapRows: Array(6).fill(0xf0) });
    return glyphs.get(cp);
  };
  const font = {
    fingerprintId: 77, atlasKey: 'stub', ascent: 15, descent: 6, lineHeight: LINE_HEIGHT,
    measureText: (text) => text.length * 6,
    getGlyph: glyph,
    hasGlyph: () => true,
    drawText(image, x, y, text, value) {
      let pen = x;
      for (const ch of text) { image.drawGlyph(font, glyph(ch.codePointAt(0)), pen, y, value); pen += 6; }
    },
  };
  return font;
}

/** Transpile one module with its imports resolved from `deps`. */
function load(file, deps) {
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { exports, console, Date, require(name) {
    assert.ok(name in deps, `Unexpected import ${name} in ${file}`);
    return deps[name];
  } });
  return exports;
}

function loadIconGrid({ lastInputWasWatch = false } = {}) {
  const font = stubFont();
  const state = { replayable: true };
  const common = {
    '../graphics/image': build('graphics/image'),
    '../graphics/textwrap': build('graphics/textwrap'),
    '../graphics/ui-fonts': { getDefaultSmallFont: () => font },
    '../util/numeric-util': build('util/numeric-util'),
    './gestures': build('ui/gestures'),
    './menu-core': build('ui/menu-core'),
    './metrics': metrics,
  };
  const menu = load('app/ui/menu.ts', { ...common, './layers': {} });
  const grid = load('app/ui/icon-grid.ts', {
    ...common,
    '../graphics/draw-expression': build('graphics/draw-expression'),
    '../graphics/display-list': build('graphics/display-list'),
    // Registration is native; any draws are replayable unless a test says not.
    '../graphics/glyph-wire': { encodeReplayDraws: (draws) => state.replayable ? { records: new Uint8Array(0), count: draws.length } : null },
    '../graphics/menu-scroll-list': build('graphics/menu-scroll-list'),
    './menu': menu,
    './menu-highlight-motion': build('ui/menu-highlight-motion'),
    './menu-scroll-motion': build('ui/menu-scroll-motion'),
    './shell/shell': { shell: { lastInputWasWatch: () => lastInputWasWatch } },
    './layers': {},
  });
  return { ...grid, state };
}

const ICON = new GrayImage(44, 44);
ICON.fillRect(10, 10, 24, 24, 200);
const ring = (type) => ({ type });
const watch = (type) => ({ type, source: 'watch' });
const BOX = { x: 0, y: 10, width: 500, height: 180 };

function makeGrid({ items = Array.from({ length: 12 }, (_, i) => `item${i}`), isWide, onActivate, onBack, watchLast } = {}) {
  const { IconGrid, state } = loadIconGrid({ lastInputWasWatch: watchLast });
  const log = { activated: [], backs: 0 };
  const data = { items };
  const grid = new IconGrid({
    items: () => data.items,
    isWide,
    describe: (item) => ({ label: item, icon: ICON }),
    onActivate: onActivate ?? ((item, index) => { log.activated.push({ item, index }); }),
    onBack: onBack ?? (() => { log.backs++; return false; }),
  });
  return { grid, log, data, state };
}

function withClock(now, fn) {
  const original = Date.now;
  Date.now = () => now;
  try { return fn(); } finally { Date.now = original; }
}

function paint(grid, now, box = BOX) {
  return withClock(now, () => {
    const image = new GrayImage(500, 200);
    grid.paint(image, box, true);
    return image;
  });
}

const animation = (image) => image.draws.find((draw) => draw.presentation?.displayList)?.presentation.displayList;

/** What the glasses show at `at`, as 4-bit values. */
function shown(image, at) {
  return withClock(at, () => Array.from(image.withDrawsBaked().pixels, (v) => Math.min(15, (v + 8) >> 4)));
}

test('rows keep their content height instead of stretching, and the next row peeks clipped', () => {
  assert.equal(metrics.iconGridMinRowHeight({ lineHeight: LINE_HEIGHT }, 44, 2), ROW_H);
  const { grid } = makeGrid({ items: Array.from({ length: 15 }, (_, i) => `item${i}`) });
  const image = paint(grid, 1000);
  const iconYs = [...new Set(image.draws.filter((d) => d.kind === 'image' && !d.presentation).map((d) => d.y))];
  assert.deepEqual(iconYs, [14, 14 + ROW_H], 'full rows are deferred draws at the natural pitch');
  const glyphYs = [...new Set(image.draws.filter((d) => d.kind === 'glyph').map((d) => d.y))];
  assert.deepEqual(glyphYs, [60, 60 + ROW_H], 'labels of full rows only');
  // The third row's top is baked into the raster, cut off at the box bottom (y 190).
  const peekTop = 14 + 2 * ROW_H;
  assert.ok(image.pixels[(peekTop + 15) * 500 + 60] > 0, 'the peeking icon shows');
  for (let y = 190; y < 200; y++) for (let x = 0; x < 500; x++) assert.equal(image.pixels[y * 500 + x], 0, `nothing below the box at (${x}, ${y})`);
  assert.equal(animation(image), undefined, 'a first paint does not animate');
});

test('the pitch only changes with the font, not with how many rows fit', () => {
  const { grid } = makeGrid();
  for (const height of [150, 180, 224]) {
    const image = paint(grid, 1000, { x: 0, y: 0, width: 500, height });
    const ys = [...new Set(image.draws.filter((d) => d.kind === 'image').map((d) => d.y))];
    for (let i = 1; i < ys.length; i++) assert.equal(ys[i] - ys[i - 1], ROW_H, `height ${height}`);
  }
});

test('scrolling rows into view animates from the old paint to the new one', async () => {
  const { grid } = makeGrid({ items: Array.from({ length: 15 }, (_, i) => `item${i}`) });
  paint(grid, 500);
  await grid.handleInput(ring('scroll-down'), null);
  const before = paint(grid, 1000);
  assert.equal(animation(before) !== undefined, true, 'moving the band animates its slide');
  const settledBefore = paint(grid, 2000);
  await grid.handleInput(ring('scroll-down'), null);
  const moving = paint(grid, 3000);
  const list = animation(moving);
  assert.ok(list, 'the scroll is retained as a display list');
  assert.deepEqual(Array.from(list.calls, (c) => c.op), [DrawOp.CLEAR, DrawOp.ROUNDED_RECT, DrawOp.DRAWS]);
  assert.ok(list.calls.every((c) => c.clip && c.clip.width === 500 && c.clip.height === 180), 'every call is clipped to the box');
  // First and last frames match the static paints on either side.
  assert.deepEqual(shown(moving, 3000), shown(settledBefore, 2000));
  const end = 3000 + MENU_HIGHLIGHT_DURATION_MS;
  const settled = paint(grid, end);
  assert.equal(animation(settled), undefined, 'the static paint takes over once the animation ends');
  assert.deepEqual(shown(moving, end), shown(settled, end));
  const middle = shown(moving, 3000 + MENU_HIGHLIGHT_DURATION_MS / 2);
  assert.notDeepEqual(middle, shown(settled, end));
  assert.notDeepEqual(middle, shown(settledBefore, 2000));
});

test('item selection slides the highlight between cells without redrawing past the scrollbar gutter', async () => {
  const { IconGrid } = loadIconGrid();
  const grid = new IconGrid({
    items: () => Array.from({ length: 30 }, (_, i) => `item${i}`),
    describe: (item) => ({ label: item, icon: ICON }), onActivate: () => {}, onBack: () => false, scrollbar: true,
  });
  paint(grid, 500);
  await grid.handleInput(ring('click'), null);
  const before = paint(grid, 1000);
  assert.equal(animation(before), undefined, 'entering item mode snaps');
  await grid.handleInput(ring('scroll-down'), null);
  const moving = paint(grid, 2000);
  const list = animation(moving);
  assert.ok(list);
  assert.equal(list.calls[0].clip.width, 495, 'the scrollbar gutter is left to the static paint');
  const rect = list.calls[1];
  const { evaluate } = build('graphics/draw-expression');
  assert.equal(evaluate(rect.x, 0).value, 200 + 6, 'starts on the middle cell');
  assert.equal(evaluate(rect.x, MENU_HIGHLIGHT_DURATION_MS).value, 300 + 6, 'rests on the next cell');
  assert.deepEqual(shown(moving, 2000), shown(before, 1000));
  const end = 2000 + MENU_HIGHLIGHT_DURATION_MS;
  assert.deepEqual(shown(moving, end), shown(paint(grid, end), end));
});

test('navigating past an end bounces and comes back', async () => {
  const { grid } = makeGrid();
  const rest = paint(grid, 1000);
  await grid.handleInput(ring('scroll-up'), null);
  const bouncing = paint(grid, 2000);
  const list = animation(bouncing);
  assert.ok(list, 'a bounce at the top is animated');
  assert.deepEqual(shown(bouncing, 2000), shown(rest, 1000));
  const peak = shown(bouncing, 2000 + Math.round(MENU_BOUNCE_DURATION_MS * 0.35));
  assert.notDeepEqual(peak, shown(rest, 1000), 'the rows move down past the top');
  // The first icon row moved 24px down (0.4 of a row, capped); the highlight moved with it.
  // Column 0's icon ink spans x 38..61 at 4-bit level 13.
  const iconTop = (image) => { for (let y = 10; y < 200; y++) if (image[y * 500 + 50] === 13) return y; };
  assert.equal(iconTop(peak) - iconTop(shown(rest, 1000)), 24);
  assert.deepEqual(shown(bouncing, 2000 + MENU_BOUNCE_DURATION_MS), shown(rest, 1000));
});

test('unreplayable rows, host navigation and taps snap', async () => {
  const { grid, state } = makeGrid({ onBack: () => { grid.resetSelection(); return false; } });
  paint(grid, 1000);
  state.replayable = false;
  await grid.handleInput(ring('scroll-down'), null);
  assert.equal(animation(paint(grid, 2000)), undefined, 'rows that cannot be replayed snap');
  state.replayable = true;
  assert.equal(animation(paint(grid, 2100)), undefined, 'the cancelled motion does not resume');
  await grid.handleInput(ring('double-click'), null);
  assert.equal(animation(paint(grid, 3000)), undefined, 'a host reset is not navigation');
  await grid.hitTest(250, 20 + ROW_H, null);
  assert.equal(animation(paint(grid, 4000)), undefined, 'a tap selects without sliding');
});

test('ring: row mode, then item mode at the middle column, linear traversal, back out', async () => {
  const { grid, log } = makeGrid();
  assert.equal(grid.selectedItem, null, 'row mode pins no item');
  await grid.handleInput(ring('click'), null);
  assert.equal(grid.selectedItem, 'item2', 'click enters item mode at the middle column');
  await grid.handleInput(ring('scroll-down'), null);
  await grid.handleInput(ring('scroll-down'), null);
  await grid.handleInput(ring('scroll-down'), null);
  assert.equal(grid.selectedItem, 'item5', 'item scrolling continues onto the next row');
  await grid.handleInput(ring('scroll-up'), null);
  assert.equal(grid.selectedItem, 'item4', 'and back onto the previous row at its end');
  await grid.handleInput(ring('click'), null);
  assert.deepEqual(log.activated, [{ item: 'item4', index: 4 }]);
  await grid.handleInput(ring('double-click'), null);
  assert.equal(grid.selectedItem, null, 'double-click drops to row mode');
  assert.equal(log.backs, 0);
  await grid.handleInput(ring('double-click'), null);
  assert.equal(log.backs, 1, 'double-click in row mode backs out');
});

test('watch: four-way cells, left from the first column backs out and stays in item mode', async () => {
  const { grid, log, data } = makeGrid({
    onBack: () => { log.backs++; grid.resetSelection(); return false; },
  });
  await grid.handleInput(watch('swipe-down'), null);
  await grid.handleInput(watch('swipe-right'), null);
  assert.equal(grid.selectedItem, 'item6', 'row 1, column 1');
  await grid.handleInput(watch('swipe-down'), null);
  assert.equal(grid.selectedItem, 'item11', 'a shorter row clamps the column');
  await grid.handleInput(watch('swipe-left'), null);
  assert.equal(grid.selectedItem, 'item10');
  assert.equal(log.backs, 0);
  await grid.handleInput(watch('swipe-left'), null);
  assert.equal(log.backs, 1);
  assert.equal(grid.selectedItem, 'item0', 'the host reset the selection, and the watch keeps a cell selected');
  data.items = ['only'];
  await grid.handleInput(watch('click'), null);
  assert.deepEqual(log.activated, [{ item: 'only', index: 0 }]);
});

test('activating or backing out of the grid returns it to row mode', async () => {
  const { grid } = makeGrid({ onActivate: async () => true, onBack: () => true });
  await grid.handleInput(watch('swipe-right'), null);
  await grid.handleInput(watch('click'), null);
  assert.equal(grid.selectedItem, null, 'a launch leaves row mode behind');
  await grid.handleInput(ring('click'), null);
  assert.notEqual(grid.selectedItem, null);
  await grid.handleInput(watch('double-click'), null);
  assert.equal(grid.selectedItem, null, 'leaving via the watch restores row mode too');
});

test('wide items take their own row and count as one item', async () => {
  const items = ['notice', 'a', 'b', 'c', 'd', 'e', 'f'];
  const { grid, log } = makeGrid({ items, isWide: (item) => item === 'notice' });
  assert.equal(grid.selectedItem, 'notice', 'a wide row is selected as a whole even in row mode');
  await grid.handleInput(ring('click'), null);
  assert.deepEqual(log.activated, [{ item: 'notice', index: 0 }], 'one click opens a wide row');
  grid.selectIndex(6);
  assert.equal(grid.cursorIndex, 6);
  assert.equal(grid.selectedItem, null, 'selectIndex keeps row mode');
  await grid.handleInput(ring('click'), null);
  assert.equal(grid.selectedItem, 'f', 'the one-item row clamps the middle column');
  await grid.handleInput(ring('scroll-up'), null);
  assert.equal(grid.selectedItem, 'e', 'item traversal walks back through the full row');
  for (let i = 0; i < 5; i++) await grid.handleInput(ring('scroll-up'), null);
  assert.equal(grid.selectedItem, 'notice');
});

test('hitTest opens the cell under the touch, including the peeking row', async () => {
  const { grid, log } = makeGrid();
  paint(grid, 1000);
  assert.equal(await grid.hitTest(50, 10 + 2 * ROW_H + 5, null), true);
  assert.deepEqual(log.activated, [{ item: 'item10', index: 10 }]);
  assert.equal(grid.selectedItem, 'item10', 'the touched cell becomes the selection');
  assert.equal(await grid.hitTest(250, 5, null), false, 'above the box');
  assert.equal(await grid.hitTest(250, 10 + 2 * ROW_H + 5, null), false, 'past the last cell of a short row');
});
