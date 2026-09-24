const test = require('node:test');
const assert = require('node:assert/strict');
const { Menu } = require('../.test-build/app/ui/menu-core.js');
const { GrayImage } = require('../.test-build/app/graphics/image.js');

/** A menu of string items whose draw callback records every row it paints. */
function stringMenu(overrides = {}) {
  const drawn = [];
  const exits = { top: 0, bottom: 0 };
  const selected = [];
  const menu = new Menu({
    items: ['a', 'b', 'c', 'd', 'e'],
    getHeight: () => 20,
    draw: (args) => {
      // A scroll animation also draws rows into a strip taller than one row; only
      // the frame's rows are recorded. A strip's selected row uses a row scratch
      // like the static one, and an empty strip falls back to the static paint,
      // so paint() keeps one draw per row.
      if (args.image !== drawn.image && args.image.height !== args.height) return;
      drawn.push({ item: args.item, index: args.index, x: args.x, y: args.y, width: args.width, height: args.height,
        selected: args.selected, focused: args.focused, scratch: args.image !== drawn.image });
    },
    onSelect: (item, index) => selected.push({ item, index }),
    onExitTop: () => exits.top++,
    onExitBottom: () => exits.bottom++,
    ...overrides,
  });
  const image = new GrayImage(100, 100);
  drawn.image = image;
  const paint = (focused = true, box = { x: 10, y: 5, width: 80, height: 60 }) => {
    drawn.length = 0;
    menu.paint(image, box, focused);
    const rows = new Map(drawn.map((row) => [row.index, row]));
    return [...rows.values()].sort((a, b) => a.index - b.index);
  };
  return { menu, paint, drawn, exits, selected, image };
}

test('defaults to the first selectable item and lays rows out from the box top', () => {
  const { menu, paint } = stringMenu();
  assert.equal(menu.selectedIndex, 0);
  const rows = paint();
  assert.deepEqual(rows.map((r) => r.item), ['a', 'b', 'c'], 'only rows that fully fit are drawn');
  assert.deepEqual(rows.map((r) => r.y), [0, 25, 45], 'the selected row draws into a scratch image at y 0');
  assert.equal(rows[0].scratch, true);
  assert.equal(rows[1].scratch, false);
  assert.equal(rows[0].width, 80);
  assert.equal(rows[0].height, 20);
  assert.ok(rows.every((r) => r.focused));
  assert.equal(paint(false)[0].focused, false);
});

test('rowGap shrinks the drawable box without changing the pitch', () => {
  const { paint } = stringMenu({ rowGap: 1 });
  const rows = paint();
  assert.deepEqual(rows.map((r) => r.height), [19, 19, 19]);
  assert.deepEqual(rows.map((r) => r.y), [0, 25, 45]);
});

test('scrolling keeps the selection and its neighbors visible and aligns the viewport to a row top', async () => {
  const { menu, paint } = stringMenu();
  await menu.handleInput({ type: 'scroll-down' });
  assert.deepEqual(paint().map((r) => r.item), ['a', 'b', 'c'], 'b and both neighbors already fit');
  await menu.handleInput({ type: 'scroll-down' });
  assert.deepEqual(paint().map((r) => r.item), ['b', 'c', 'd'], 'c reveals d below it');
  await menu.handleInput({ type: 'scroll-down' });
  assert.equal(menu.selectedIndex, 3);
  assert.deepEqual(paint().map((r) => r.item), ['c', 'd', 'e']);
  assert.equal(menu.scrollTop, 40);
  await menu.handleInput({ type: 'scroll-up' });
  await menu.handleInput({ type: 'scroll-up' });
  await menu.handleInput({ type: 'scroll-up' });
  assert.equal(menu.selectedIndex, 0);
  assert.deepEqual(paint().map((r) => r.item), ['a', 'b', 'c']);
  assert.equal(menu.scrollTop, 0);
});

test('without wrap the ends call the exit callbacks and hold the selection', async () => {
  const { menu, exits } = stringMenu();
  await menu.handleInput({ type: 'scroll-up' });
  assert.equal(menu.selectedIndex, 0);
  assert.equal(exits.top, 1);
  menu.select(4);
  await menu.handleInput({ type: 'scroll-down' });
  assert.equal(menu.selectedIndex, 4);
  assert.equal(exits.bottom, 1);
});

test('with wrap the ends connect and the exit callbacks stay quiet', async () => {
  const { menu, exits } = stringMenu({ wrap: true });
  await menu.handleInput({ type: 'scroll-up' });
  assert.equal(menu.selectedIndex, 4);
  await menu.handleInput({ type: 'scroll-down' });
  assert.equal(menu.selectedIndex, 0);
  assert.deepEqual(exits, { top: 0, bottom: 0 });
});

test('navigation skips unselectable items and never lands on them', async () => {
  const { menu } = stringMenu({
    items: ['Group', 'a', 'b', 'Group 2', 'c'],
    isSelectable: (item) => !item.startsWith('Group'),
  });
  assert.equal(menu.selectedIndex, 1, 'initial selection skips the leading heading');
  await menu.handleInput({ type: 'scroll-down' });
  await menu.handleInput({ type: 'scroll-down' });
  assert.equal(menu.selectedIndex, 4, 'the heading between b and c is skipped');
  await menu.handleInput({ type: 'scroll-down' });
  assert.equal(menu.selectedIndex, 4);
  menu.select(3);
  assert.equal(menu.selectedIndex, 4, 'selecting a heading lands on the next selectable item');
  menu.select(0);
  assert.equal(menu.selectedIndex, 1);
});

test('a null selection draws no highlight, and scrolling from it picks an end', async () => {
  const { menu, paint } = stringMenu({ selectedIndex: null });
  assert.equal(menu.selectedIndex, null);
  assert.equal(menu.selectedItem, null);
  assert.ok(paint().every((r) => !r.selected && !r.scratch));
  assert.equal(await menu.handleInput({ type: 'click' }), false);
  await menu.handleInput({ type: 'scroll-up' });
  assert.equal(menu.selectedIndex, 4);
  menu.select(null);
  await menu.handleInput({ type: 'scroll-down' });
  assert.equal(menu.selectedIndex, 0);
});

test('with nothing selectable, up and down page the content and exit at the ends', async () => {
  const { menu, paint, exits } = stringMenu({ isSelectable: () => false });
  paint();
  assert.equal(menu.selectedIndex, null);
  await menu.handleInput({ type: 'scroll-down' });
  assert.equal(menu.scrollTop, 20);
  await menu.handleInput({ type: 'scroll-down' });
  assert.equal(menu.scrollTop, 40, 'clamped to the content end');
  await menu.handleInput({ type: 'scroll-down' });
  assert.equal(exits.bottom, 1);
  await menu.handleInput({ type: 'scroll-up' });
  await menu.handleInput({ type: 'scroll-up' });
  assert.equal(menu.scrollTop, 0);
  await menu.handleInput({ type: 'scroll-up' });
  assert.equal(exits.top, 1);
});

test('click activates the selected item and reports other events as unhandled', async () => {
  const { menu, selected } = stringMenu();
  menu.select(2);
  assert.equal(await menu.handleInput({ type: 'click' }), true);
  assert.deepEqual(selected, [{ item: 'c', index: 2 }]);
  assert.equal(await menu.handleInput({ type: 'double-click' }), false);
});

test('setItems keeps the index by default, takes an explicit one, and holds the selected row in place', () => {
  const { menu, paint } = stringMenu();
  menu.select(3);
  paint();
  assert.equal(menu.scrollTop, 40, 'row d sits above its neighbor e at the bottom of the viewport');
  menu.setItems(['x', 'y', 'z', 'd2', 'e2', 'f2', 'g2']);
  assert.equal(menu.selectedIndex, 3);
  assert.equal(menu.scrollTop, 40);
  menu.setItems(['x', 'y', 'z', 'w', 'v', 'u', 'd3'], 6);
  assert.equal(menu.selectedIndex, 6);
  paint();
  assert.equal(menu.scrollTop, 80, 'row d3 (top 120) stays at the bottom, 40 px below the viewport top');
  menu.setItems(['only'], null);
  assert.equal(menu.selectedIndex, null);
  menu.setItems(['p', 'q'], 9);
  assert.equal(menu.selectedIndex, 1, 'an out-of-range index clamps');
});

test('variable heights: the layout follows getHeight and partial rows are hidden', () => {
  const heights = { a: 10, b: 30, c: 15, d: 40, e: 5 };
  const { menu, paint } = stringMenu({ getHeight: (item) => heights[item] });
  let rows = paint();
  assert.deepEqual(rows.map((r) => [r.item, r.y, r.height]), [['a', 0, 10], ['b', 15, 30], ['c', 45, 15]]);
  menu.select(3);
  rows = paint();
  assert.equal(menu.scrollTop, 40, 'aligned to the top of row c');
  assert.deepEqual(rows.map((r) => [r.item, r.y]), [['c', 5], ['d', 0], ['e', 60]], 'e fits under d exactly');
  assert.equal(menu.overflows, true);
});

test('a selected row taller than the box is drawn from its top', () => {
  const { menu, paint } = stringMenu({ getHeight: (item) => (item === 'c' ? 90 : 20) });
  menu.select(2);
  const rows = paint();
  assert.deepEqual(rows.map((r) => r.item), ['c']);
  assert.equal(menu.scrollTop, 40);
});

test('the selection re-validates against items edited in place', async () => {
  const items = ['a', 'b', 'c'];
  const { menu } = stringMenu({ items });
  menu.select(2);
  items.length = 1;
  assert.equal(menu.selectedIndex, 0);
  items.length = 0;
  assert.equal(menu.selectedIndex, null);
  items.push('z');
  await menu.handleInput({ type: 'scroll-down' });
  assert.equal(menu.selectedIndex, 0);
});

test('the highlight is a replayed selection over the row scratch image', () => {
  const { paint, image } = stringMenu();
  paint();
  const selection = image.draws.find((d) => d.presentation);
  assert.ok(selection);
  assert.equal(selection.x, 10);
  assert.equal(selection.y, 5);
  assert.equal(selection.presentation.radius, 8);
  assert.equal(selection.presentation.background, 15);
  assert.equal(selection.presentation.border, 45);
  const unfocused = new GrayImage(100, 100);
  stringMenu().menu.paint(unfocused, { x: 0, y: 0, width: 50, height: 50 }, false);
  assert.equal(unfocused.draws.find((d) => d.presentation).presentation.background, 0);
  const plain = new GrayImage(100, 100);
  stringMenu({ highlight: false }).menu.paint(plain, { x: 0, y: 0, width: 50, height: 50 }, true);
  assert.equal(plain.draws.some((d) => d.presentation), false);
});

test('indexAt maps a viewport coordinate to the selectable item under it', () => {
  const { menu, paint } = stringMenu({ isSelectable: (item) => item !== 'b' });
  paint();
  assert.equal(menu.indexAt(4), null, 'above the box');
  assert.equal(menu.indexAt(5), 0);
  assert.equal(menu.indexAt(30), null, 'row b is not selectable');
  assert.equal(menu.indexAt(50), 2);
  assert.equal(menu.indexAt(65), null, 'below the box');
});

test('the scrollbar tracks the pixel scroll fraction', () => {
  const { menu, paint, image } = stringMenu();
  paint();
  image.clear();
  menu.drawScrollbar(image, 95, 5, 60);
  assert.equal(image.getPixel(95, 5), 120, 'thumb at the top');
  assert.equal(image.getPixel(95, 60), 30, 'track below it');
  menu.select(4);
  paint();
  image.clear();
  menu.drawScrollbar(image, 95, 5, 60);
  assert.equal(image.getPixel(95, 5), 30);
  assert.equal(image.getPixel(95, 64), 120, 'thumb at the bottom');
  const short = stringMenu({ items: ['a'] });
  short.paint();
  short.image.clear();
  short.menu.drawScrollbar(short.image, 95, 5, 60);
  assert.equal(short.image.getPixel(95, 5), 0, 'no scrollbar when the content fits');
});

test('a menu created empty starts on the first selectable item once items arrive', () => {
  const { menu } = stringMenu({ items: [], isSelectable: (item) => !item.startsWith('Group') });
  assert.equal(menu.selectedIndex, null);
  menu.setItems(['Group', 'a', 'b']);
  assert.equal(menu.selectedIndex, 1, 'skips a leading heading');
  menu.setItems([]);
  assert.equal(menu.selectedIndex, null);
  menu.setItems(['x', 'y']);
  assert.equal(menu.selectedIndex, 0, 'emptying and refilling starts over at the top');
});

test('an explicit deselection survives setItems until the user or caller selects', async () => {
  const { menu } = stringMenu({ items: [] , selectedIndex: null });
  menu.setItems(['a', 'b']);
  assert.equal(menu.selectedIndex, null, 'constructed with no selection');
  menu.select(1);
  menu.setItems(['a', 'b', 'c'], null);
  menu.setItems(['a', 'b', 'c', 'd']);
  assert.equal(menu.selectedIndex, null, 'setItems without an index keeps the deselection');
  await menu.handleInput({ type: 'scroll-down' });
  assert.equal(menu.selectedIndex, 0);
  menu.setItems([]);
  menu.setItems(['p', 'q']);
  assert.equal(menu.selectedIndex, 0, 'scrolling ended the deselection');
});

test('setItems never leaves the viewport scrolled past the end of the list', () => {
  // Box 60px, rows 20px: a 3-row list fits, so it must sit at the top.
  const { menu, paint } = stringMenu({ items: ['b', 'c', 'd'] });
  menu.select(2);
  paint();
  assert.equal(menu.scrollTop, 0);
  menu.setItems(['a', 'b', 'c'], 2);
  assert.deepEqual(paint().map((r) => r.item), ['a', 'b', 'c'], 'a row sorted in above stays visible');
  assert.equal(menu.scrollTop, 0);
  // The selected row near the top of a scrolled viewport loses the rows below it:
  // keeping its on-screen position would leave a gap, so pull back to show the end.
  const long = stringMenu({ items: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
  long.menu.select(6);
  long.paint();
  long.menu.select(4);
  long.paint();
  assert.equal(long.menu.scrollTop, 60, 'd, above e, is the top row');
  long.menu.setItems(['a', 'b', 'c', 'd', 'e'], 4);
  assert.deepEqual(long.paint().map((r) => r.item), ['c', 'd', 'e']);
  assert.equal(long.menu.scrollTop, 40);
});
