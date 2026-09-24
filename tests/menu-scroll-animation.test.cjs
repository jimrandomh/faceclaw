const test = require('node:test');
const assert = require('node:assert/strict');
const { Menu } = require('../.test-build/app/ui/menu-core.js');
const { MENU_HIGHLIGHT_DURATION_MS } = require('../.test-build/app/ui/menu-highlight-motion.js');
const { GrayImage } = require('../.test-build/app/graphics/image.js');
const { DrawOp, encodeDisplayList, readDisplayList } = require('../.test-build/app/graphics/display-list.js');
const { evaluate } = require('../.test-build/app/graphics/draw-expression.js');
const { menuScrollList } = require('../.test-build/app/graphics/menu-scroll-list.js');
const { encodePresentation } = require('../.test-build/app/graphics/presentation-wire.js');
// Also consumed by FrameDisplayListTest.kt.
const SCROLL = '0787000000030002000400020000070000009600000001000200040011223344556677880200020000000000ff220100300102300180f0800180f0161101001732800180f01610300180f0302341403102000200010008000000ff280101300100300180f0800180f0161101001732800180f01610300180f030234140310100170100160400020000000103';

const BOX = { x: 10, y: 5, width: 40, height: 60 };
const ITEMS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

function withClock(now, fn) {
  const original = Date.now;
  Date.now = () => now;
  try { return fn(); } finally { Date.now = original; }
}

/** 20px rows whose ink ignores selection, so frames compare across selection changes. */
function inkMenu(overrides = {}) {
  return new Menu({
    items: ITEMS,
    getHeight: () => 20,
    draw: ({ image, index, x, y }) => image.fillRect(x + 2 + index, y + 4, 6, 8, 200),
    ...overrides,
  });
}

function paint(menu, now, { box = BOX, background = 0, size = [64, 72] } = {}) {
  return withClock(now, () => {
    const image = new GrayImage(size[0], size[1], background);
    menu.paint(image, box, true);
    return image;
  });
}

const scrollLists = (image) => image.draws
  .map((draw) => draw.presentation?.displayList)
  .filter((list) => list?.calls.some((call) => call.op === DrawOp.RECT_COPY));

/** What the glasses show at `at`, as 4-bit values. */
function shown(image, at) {
  return withClock(at, () => Array.from(image.withDrawsBaked().pixels, (v) => Math.min(15, (v + 8) >> 4)));
}

test('navigation that scrolls animates a strip covering both viewports', () => {
  const menu = inkMenu();
  menu.select(1);
  const before = paint(menu, 1000);
  assert.equal(menu.scrollTop, 0);
  menu.moveSelection(1);
  const moving = paint(menu, 2000);
  assert.equal(menu.scrollTop, 20, 'c scrolls d into view');
  const [list] = scrollLists(moving);
  assert.ok(list, 'a scroll display list is retained');
  const [strip] = list.resources;
  assert.equal(strip.height, 80, 'the strip spans the old and new viewports');
  assert.ok(strip.width < BOX.width, 'the strip is cropped to the ink columns');
  const copy = list.calls[0];
  assert.equal(copy.op, DrawOp.RECT_COPY);
  assert.equal(copy.height, BOX.height);
  assert.deepEqual(evaluate(copy.y, 0, 0), { value: 0, pending: true });
  assert.equal(evaluate(copy.y, MENU_HIGHLIGHT_DURATION_MS / 2, 0).value, 10);
  assert.deepEqual(evaluate(copy.y, MENU_HIGHLIGHT_DURATION_MS, 0), { value: 20, pending: false });
  assert.equal(list.calls[1].op, DrawOp.ROUNDED_RECT, 'the highlight is drawn over the copied rows');
  assert.equal(moving.draws.filter((draw) => draw.presentation && !draw.presentation.displayList?.calls.some((c) => c.op === DrawOp.RECT_COPY)).length, 0,
    'the selected row is in the strip, not a separate selection');

  // First and last frames match the static paints on either side.
  assert.deepEqual(shown(moving, 2000), shown(before, 1000));
  const end = 2000 + MENU_HIGHLIGHT_DURATION_MS;
  const settled = paint(menu, end);
  assert.equal(scrollLists(settled).length, 0, 'the static paint takes over once the animation ends');
  assert.deepEqual(shown(moving, end), shown(settled, end));
});

test('a second move during the scroll starts from the offset on screen', () => {
  const menu = inkMenu();
  menu.select(1);
  paint(menu, 1000);
  menu.moveSelection(1);
  paint(menu, 2000);
  menu.moveSelection(1);
  const image = paint(menu, 2000 + MENU_HIGHLIGHT_DURATION_MS / 2);
  assert.equal(menu.scrollTop, 40);
  const [list] = scrollLists(image);
  assert.equal(list.resources[0].height, 90, 'the strip starts at the current offset, 10');
  assert.equal(evaluate(list.calls[0].y, 0, 0).value, 0);
  assert.equal(evaluate(list.calls[0].y, MENU_HIGHLIGHT_DURATION_MS, 0).value, 30);
});

test('wraps, programmatic moves, busy backgrounds and oversized strips snap', () => {
  const wrapping = inkMenu({ wrap: true });
  wrapping.select(6);
  paint(wrapping, 1000);
  wrapping.moveSelection(1);
  assert.equal(scrollLists(paint(wrapping, 2000)).length, 0, 'wrap');

  const jumped = inkMenu();
  paint(jumped, 1000);
  jumped.select(5);
  assert.equal(scrollLists(paint(jumped, 2000)).length, 0, 'select()');

  const busy = inkMenu();
  busy.select(1);
  paint(busy, 1000, { background: 100 });
  busy.moveSelection(1);
  const covered = paint(busy, 2000, { background: 100 });
  assert.equal(scrollLists(covered).length, 0, 'the opaque copy would hide the host background');
  assert.equal(covered.draws.filter((draw) => draw.presentation).length, 1, 'the selection is still drawn');

  // 600px-wide rows: a 600x220 strip exceeds the 64 KiB resource limit unless cropped.
  const wide = (inkWidth) => {
    const menu = new Menu({ items: Array.from({ length: 20 }, (_, i) => i), getHeight: () => 20,
      draw: ({ image, x, y }) => image.fillRect(x, y + 4, inkWidth, 8, 200) });
    const options = { box: { x: 0, y: 0, width: 600, height: 200 }, size: [640, 240] };
    menu.select(8);
    paint(menu, 1000, options);
    menu.moveSelection(1);
    return scrollLists(paint(menu, 2000, options));
  };
  assert.equal(wide(600).length, 0, 'too large');
  assert.equal(wide(40).length, 1, 'narrow ink crops under the limit');
  assert.equal(wide(40)[0].resources[0].width, 40);
});

test('scroll lists survive the bridge with animated copy coordinates', () => {
  const strip = { width: 2, height: 4, pixels: Uint8Array.of(17, 34, 51, 68, 85, 102, 119, 136) };
  const list = menuScrollList(strip, 1, 0, 2, { from: 0, to: 2, startedAt: 1000, token: 7, durationMs: MENU_HIGHLIGHT_DURATION_MS },
    { y: 0, width: 4, height: 2, radius: 0, background: 15, border: 45, animation: { dx: 0, dy: 1, startedAt: 1000, token: 7, durationMs: MENU_HIGHLIGHT_DURATION_MS } });
  const bytes = encodeDisplayList({ displayList: list, x: 3, y: 2, width: 4, height: 2, depth: 0 }, 1150);
  assert.equal(Buffer.from(bytes).toString('hex'), SCROLL);
  const { placed } = readDisplayList(bytes, 0, 1150);
  const [copy, box] = placed.displayList.calls;
  assert.equal(evaluate(copy.y, 150, 0).value, 1);
  assert.deepEqual(evaluate(copy.y, 150, 90), { value: 2, pending: false });
  assert.equal(copy.dx, 1);
  assert.equal(evaluate(box.y, 0, 0).value, 0, 'the highlight is clamped inside the viewport');

  const image = new GrayImage(8, 8);
  image.drawDisplayList(list, 3, 2, 4, 2);
  assert.ok(encodePresentation(image.draws[0]).length > 0);
});
