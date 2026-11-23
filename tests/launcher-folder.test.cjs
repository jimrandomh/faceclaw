const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');
const build = (name) => require(`../.test-build/app/${name}.js`);

const WIDTH = 576, HEIGHT = 288;
const LINE_HEIGHT = 21;
// At Normal menu animation speed (FOLDER_TRANSITION_MS in launcher-app.ts).
const TRANSITION_MS = 200;
const ring = (type) => ({ type });
const level = (v) => Math.min(15, (v + 8) >> 4);

// ---- folder-transition.ts on its own -----------------------------------

test('a folder transition grows the panel out of a point over what it covers, and shrinks it away to nothing', () => {
  const { folderTransitionList } = build('apps/launcher/folder-transition');
  const { DrawOp, paintDisplayList } = build('graphics/display-list');
  const panel = { width: 20, height: 10 };
  // The panel's inside is a block of 9s at (2, 2); under the panel the frame was all 5s.
  const content = (clip) => [{ op: DrawOp.ROUNDED_RECT, x: 2, y: 2, width: 6, height: 3, radius: 0, background: 9, border: 16, clip }];
  const underneath = (clip) => [{ op: DrawOp.ROUNDED_RECT, x: 0, y: 0, width: 20, height: 10, radius: 0, background: 5, border: 16, clip }];
  const paint = (list, base, at) => {
    const output = base.slice();
    const original = Date.now; Date.now = () => at;
    try { paintDisplayList(output, base, 30, 16, { displayList: list, x: 4, y: 3, width: 20, height: 10, depth: 0 }, false, at); }
    finally { Date.now = original; }
    return Array.from(output, level);
  };
  const frame = (fill, panelPixel) => {
    const pixels = new Uint8Array(30 * 16).fill(fill * 16);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) pixels[(3 + y) * 30 + 4 + x] = panelPixel(x, y) * 16;
    return pixels;
  };
  const openPanel = (x, y) => x === 0 || y === 0 || x === 19 || y === 9 ? 4 : x >= 2 && x < 8 && y >= 2 && y < 5 ? 9 : 0;
  // Opening: the frame underneath holds the open panel; before, it was 5s everywhere.
  const open = frame(5, openPanel);
  const opening = folderTransitionList({ kind: 'open', startedAt: 1000, token: 1, durationMs: 200 }, panel, { x: 3, y: 4 }, 4, content, underneath);
  assert.deepEqual(paint(opening, open, 1000), Array.from(frame(5, () => 5), level), 'starts as the frame before the folder opened');
  assert.deepEqual(paint(opening, open, 1200), Array.from(open, level), 'ends as the open panel, exactly');
  assert.deepEqual(paint(opening, open, 9000), Array.from(open, level));
  // In between: a smaller panel, bordered, with the 5s around it and the block's part inside it showing.
  const middle = paint(opening, open, 1040);
  const at = (x, y) => middle[(3 + y) * 30 + 4 + x];
  const border = [];
  for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) if (at(x, y) === 4) border.push([x, y]);
  const xs = border.map(([x]) => x), ys = border.map(([, y]) => y);
  const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  assert.ok(left > 0 && left <= 3 && right >= 3 && right < 19 && top > 0 && top <= 4 && bottom >= 4 && bottom < 9, `${[left, right, top, bottom]}`);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) {
    const inside = x > left && x < right && y > top && y < bottom;
    const onBorder = (x === left || x === right) && y >= top && y <= bottom || (y === top || y === bottom) && x >= left && x <= right;
    assert.equal(at(x, y), onBorder ? 4 : inside ? openPanel(x, y) === 9 ? 9 : 0 : 5, `(${x}, ${y})`);
  }
  // Closing: the frame underneath is what is left behind (all 5s); the list is the panel shrinking away.
  const closed = frame(5, () => 5);
  const closing = folderTransitionList({ kind: 'close', startedAt: 1000, token: 2, durationMs: 200 }, panel, { x: 3, y: 4 }, 4, content);
  assert.deepEqual(paint(closing, closed, 1000), Array.from(open, level), 'starts as the open panel');
  assert.deepEqual(paint(closing, closed, 1200), Array.from(closed, level), 'ends with nothing drawn');
  assert.deepEqual(Array.from(closing.calls, (call) => call.op), [DrawOp.CLEAR, DrawOp.ROUNDED_RECT, DrawOp.LINE, DrawOp.LINE, DrawOp.LINE, DrawOp.LINE]);
  assert.ok(closing.calls.every((call) => call.clip.animated), 'everything shows through the one moving rect');
  // Content or background that can't be replayed: no list, the folder just appears.
  const transition = { kind: 'open', startedAt: 1000, token: 3, durationMs: 200 };
  assert.equal(folderTransitionList(transition, panel, { x: 3, y: 4 }, 4, () => null, underneath), null);
  assert.equal(folderTransitionList(transition, panel, { x: 3, y: 4 }, 4, content, () => null), null);
  assert.equal(folderTransitionList(transition, panel, { x: 3, y: 4 }, 4, content), null);
});

// ---- the launcher's layers ---------------------------------------------

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

function launcher({ speed = 'normal', folders = { app03: 'AAA', app04: 'AAA', app05: 'AAA' }, watch = false } = {}) {
  const clock = { now: 1000 };
  const font = stubFont();
  const settings = new Map([['display.menuAnimationSpeed', speed], ['launcher.folders', JSON.stringify(folders)]]);
  const listeners = [];
  const state = { replayable: true, launched: [], yielded: 0, renders: 0, stack: null };
  const store = {
    getStringSetting: (key, fallback) => settings.get(key) ?? fallback,
    setStringSetting: (key, value) => { settings.set(key, value); for (const listener of [...listeners]) listener(); },
  };
  const shell = { shell: { yieldFocusToSidebar: () => { state.yielded++; }, lastInputWasWatch: () => watch } };
  const glyphWire = { encodeReplayDraws: (draws) => state.replayable ? { records: new Uint8Array(0), count: draws.length } : null };
  const fonts = { getDefaultSmallFont: () => font };
  const mocks = {
    '../../graphics/ui-fonts': fonts, '../graphics/ui-fonts': fonts,
    '../../graphics/glyph-wire': glyphWire, '../graphics/glyph-wire': glyphWire,
    '../../native/settings-store': store, '../native/settings-store': store,
    '../../ui/shell/shell': shell, './shell/shell': shell,
    '../graphics/screen-size': { screenWidth: () => 640, screenHeight: () => 480 },
    '../native/frame-timings': { spanCurrent: (_name, fn) => fn() },
    '../../ui/window-menu': { WINDOW_MENU_LAYOUT: { x: 8, y: 8, width: 272 } },
    '../../ui/dashboard-settings': { onAnySettingChanged: (listener) => { listeners.push(listener); } },
  };
  const load = loader({ Date: { now: () => clock.now }, Map, Set, JSON, Math, Uint8Array }, mocks);
  const { GrayImage } = load('app/graphics/image.ts');
  const { LayerStack } = load('app/ui/layers.ts');
  const icons = new Map();
  mocks['../../graphics/icons'] = { renderIcon: (name) => {
    if (!icons.has(name)) {
      const icon = new GrayImage(44, 44);
      icon.fillRect(8, 8, 28, 28, name === 'folder-filled' ? 240 : 160);
      icons.set(name, icon);
    }
    return icons.get(name);
  } };
  mocks['../../ui/shell/in-process-window'] = { createInProcessWindow: (options) => {
    const stack = new LayerStack(options.baseLayer, { requestRender() {} }, { width: WIDTH, height: HEIGHT }, () => true);
    state.stack = stack;
    state.menuItems = options.menuItems;
    return { window: { windowId: options.windowId }, stack, requestRender: () => { state.renders++; } };
  } };
  const { createLauncherWindow } = load('app/apps/launcher/launcher-app.ts');
  const { flattenPlanesWithDraws } = load('app/graphics/plane.ts');
  const { paintDisplayList, DrawOp } = load('app/graphics/display-list.ts');
  const folderStore = load('app/apps/launcher/launcher-folders.ts');
  const apps = Array.from({ length: 12 }, (_, i) => ({ appId: `app${String(i).padStart(2, '0')}`, label: `App${String(i).padStart(2, '0')}`, icon: 'box' }));
  createLauncherWindow({
    actions: {}, apps: () => apps, launchApp: async (appId) => { state.launched.push(appId); }, uninstallApp: async () => {},
    submitFrame: async () => {}, setSurfaceVisible: () => {},
  });
  const stack = state.stack;
  /** Paint the window at `at`: its planes, flattened as submitted, and the display lists that go over them. */
  const paint = (at) => {
    clock.now = at;
    const planes = stack.paint();
    const { image, draws } = flattenPlanesWithDraws(planes, { width: WIDTH, height: HEIGHT });
    const lists = draws.filter((draw) => draw.kind === 'image' && draw.presentation?.displayList);
    return { planes, image, lists };
  };
  /** What the glasses show of a painted frame at `at`, as 4-bit levels. */
  const shown = (frame, at) => {
    clock.now = at;
    const output = frame.image.pixels.slice();
    for (const draw of frame.lists) {
      paintDisplayList(output, frame.image.pixels, WIDTH, HEIGHT, { displayList: draw.presentation.displayList,
        x: draw.x, y: draw.y, width: draw.source.width, height: draw.source.height, depth: draw.presentation.depth }, false, at);
    }
    return Array.from(output, level);
  };
  /** One plane of a painted frame alone, with nothing over it. */
  const plane = (frame, index) => Array.from(flattenPlanesWithDraws([frame.planes[index]], { width: WIDTH, height: HEIGHT }).image.pixels, level);
  const input = async (event, at) => { clock.now = at; await stack.handleInput(event); };
  /** Ring: into item mode on the first row, across to the folder's cell (the first), and open it. */
  const openFolder = async (at) => {
    await input(ring('click'), at);
    await input(ring('scroll-up'), at);
    await input(ring('scroll-up'), at);
    await input(ring('click'), at);
  };
  return { state, stack, paint, shown, plane, input, openFolder, clock, DrawOp, folderStore, listeners };
}

/** The bounds of the folder panel in a frame: where its one-pixel border (gray 72) is. */
function panelRect(frame) {
  let left = WIDTH, right = -1, top = HEIGHT, bottom = -1;
  const pixels = frame.planes[frame.planes.length - 1].image.pixels;
  pixels.forEach((value, i) => {
    if (value !== 72) return;
    left = Math.min(left, i % WIDTH); right = Math.max(right, i % WIDTH);
    top = Math.min(top, (i / WIDTH) | 0); bottom = Math.max(bottom, (i / WIDTH) | 0);
  });
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

test('a folder opens as a panel over the top grid, out of its icon, and the last frame is the painted panel', async () => {
  const l = launcher();
  const closed = l.paint(1000);
  assert.equal(closed.planes.length, 1);
  await l.openFolder(2000);
  assert.equal(l.stack.isAtBase(), false, 'the folder is a layer of its own');
  const opening = l.paint(2000);
  assert.equal(opening.planes.length, 2, 'the top grid stays underneath');
  assert.equal(opening.lists.length, 1);
  const panel = panelRect(opening);
  assert.ok(panel.x > 0 && panel.y > 0 && panel.x + panel.width < WIDTH && panel.y + panel.height < HEIGHT, `smaller than the window: ${JSON.stringify(panel)}`);
  // One row of three apps: the panel is only as tall as that takes.
  assert.ok(panel.height < HEIGHT / 2, `fits its rows: ${panel.height}`);
  const [list] = opening.lists;
  assert.deepEqual([list.x, list.y, list.source.width, list.source.height], [panel.x, panel.y, panel.width, panel.height]);

  // First frame: the top grid alone (out of focus now), as if no panel were there.
  assert.deepEqual(l.shown(opening, 2000), l.plane(opening, 0));
  // Last frame, and ever after: exactly the frame's own pixels.
  const settled = l.paint(2000 + TRANSITION_MS);
  assert.equal(settled.lists.length, 0, 'the static paint takes over');
  const still = l.shown(settled, 2000 + TRANSITION_MS);
  assert.deepEqual(l.shown(opening, 2000 + TRANSITION_MS), still);
  assert.deepEqual(l.shown(opening, 60000), still);
  // The panel covers the grid under it: nothing of the top grid's icons inside its border.
  const under = l.plane(settled, 0);
  let covered = 0;
  for (let y = panel.y; y < panel.y + panel.height; y++) for (let x = panel.x; x < panel.x + panel.width; x++) covered += under[y * WIDTH + x] !== 0 && still[y * WIDTH + x] === 0;
  assert.ok(covered > 100, 'grid pixels hidden by the panel');
  // In between the panel is partly open: neither frame, and it grows.
  const sizes = [2040, 2080, 2120, 2160].map((at) => {
    const pixels = l.shown(opening, at);
    assert.notDeepEqual(pixels, still);
    return pixels.reduce((count, value, i) => count + (value !== under[i] ? 1 : 0), 0);
  });
  for (let i = 1; i < sizes.length; i++) assert.ok(sizes[i] > sizes[i - 1], `the open part grows: ${sizes}`);
});

test('backing out closes the panel into its icon; the last frame is the top grid', async () => {
  const l = launcher();
  l.paint(1000);
  await l.openFolder(2000);
  const open = l.paint(3000);
  assert.equal(open.lists.length, 0);
  const openPixels = l.shown(open, 3000);
  const panel = panelRect(open);
  await l.input(ring('double-click'), 4000);
  assert.equal(l.stack.isAtBase(), true);
  assert.equal(l.state.yielded, 0, 'back leaves the folder, not the launcher');
  const closing = l.paint(4000);
  assert.equal(closing.planes.length, 1);
  assert.equal(closing.lists.length, 1);
  // First frame: the panel still whole, where it was.
  const first = l.shown(closing, 4000);
  for (let y = panel.y; y < panel.y + panel.height; y++) for (let x = panel.x; x < panel.x + panel.width; x++) {
    assert.equal(first[y * WIDTH + x], openPixels[y * WIDTH + x], `(${x}, ${y})`);
  }
  // Last frame: the grid, with nothing left of the panel.
  const settled = l.paint(4000 + TRANSITION_MS);
  assert.equal(settled.lists.length, 0);
  assert.deepEqual(l.shown(closing, 4000 + TRANSITION_MS), l.shown(settled, 4000 + TRANSITION_MS));
  assert.notDeepEqual(l.shown(closing, 4100), l.shown(settled, 4000 + TRANSITION_MS));
  // The selection is back on the folder's cell, in focus.
  await l.input(ring('click'), 5000);
  assert.equal(l.stack.isAtBase(), false, 'a click opens the same folder again');
});

test('a folder\'s apps launch from it, and the launcher is back at its top grid afterwards', async () => {
  const l = launcher();
  l.paint(1000);
  await l.openFolder(2000);
  l.paint(2000 + TRANSITION_MS);
  await l.input(ring('click'), 3000); // item mode, at the grid's middle column: the third of its three apps
  await l.input(ring('click'), 3000);
  assert.deepEqual(l.state.launched, ['app05']);
  assert.equal(l.stack.isAtBase(), true);
  assert.equal(l.paint(3000).lists.length, 0, 'no closing animation behind a launching app');
});

test('touches: on the panel they open an app, off it they close the folder', async () => {
  const l = launcher();
  l.paint(1000);
  await l.openFolder(2000);
  const panel = panelRect(l.paint(3000));
  l.clock.now = 3000;
  assert.equal(await l.stack.hitTest(panel.x - 5, panel.y + 10), true);
  assert.equal(l.stack.isAtBase(), true, 'outside the panel closes it');
  assert.deepEqual(l.state.launched, []);
  l.paint(3000 + TRANSITION_MS);
  await l.input(ring('click'), 4000);
  const reopened = panelRect(l.paint(5000));
  // The first cell's icon: a fifth of the way across the folder's grid, under the name.
  assert.equal(await l.stack.hitTest(reopened.x + 40, reopened.y + reopened.height - 40), true);
  assert.deepEqual(l.state.launched, ['app03']);
});

test('a folder emptied from elsewhere closes; the context menu follows the folder\'s selection', async () => {
  const l = launcher();
  l.paint(1000);
  await l.openFolder(2000);
  l.paint(3000);
  assert.deepEqual(Array.from(l.state.menuItems(), (item) => item.label), [], 'a row of the folder is not one app');
  await l.input(ring('click'), 3000);
  assert.deepEqual(Array.from(l.state.menuItems(), (item) => item.label), ['Move to folder']);
  l.folderStore.setAppFolder('app03', null);
  assert.equal(l.stack.isAtBase(), false, 'two apps left');
  l.folderStore.setAppFolder('app04', null);
  l.folderStore.setAppFolder('app05', null);
  assert.equal(l.stack.isAtBase(), true);
  assert.ok(l.state.renders >= 3);
  const frame = l.paint(4000);
  assert.equal(frame.planes.length, 1);
  assert.equal(frame.lists.length, 0);
});

test('with menu animation disabled, or content the glasses cannot replay, the folder just opens and closes', async () => {
  for (const options of [{ speed: 'disabled' }, { unreplayable: true }]) {
    const l = launcher(options);
    if (options.unreplayable) l.state.replayable = false;
    l.paint(1000);
    await l.openFolder(2000);
    const open = l.paint(2000);
    assert.equal(open.planes.length, 2);
    assert.equal(open.lists.length, 0);
    await l.input(ring('double-click'), 3000);
    assert.equal(l.paint(3000).lists.length, 0);
  }
});

test('the watch lands on a single app in a folder, and left from its first column closes it', async () => {
  const l = launcher({ watch: true });
  const watch = (type) => ({ type, source: 'watch' });
  l.paint(1000);
  await l.input(watch('click'), 2000); // the first cell: the folder
  assert.equal(l.stack.isAtBase(), false);
  l.paint(2000);
  assert.deepEqual(Array.from(l.state.menuItems(), (item) => item.label), ['Move to folder'], 'one app is selected at once');
  await l.input(watch('swipe-left'), 3000);
  assert.equal(l.stack.isAtBase(), true);
  assert.equal(l.state.yielded, 0);
});
