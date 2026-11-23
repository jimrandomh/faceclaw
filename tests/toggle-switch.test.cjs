const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const build = (name) => require(`../.test-build/app/${name}.js`);
const { GrayImage, TOGGLE_SWITCH_WIDTH: W, TOGGLE_SWITCH_HEIGHT: H } = build('graphics/image');
const { DrawOp, encodeDisplayList, readDisplayList } = build('graphics/display-list');
const { toggleSwitchList, toggleSwitchLook } = build('graphics/toggle-switch-list');

const MOTION = { startedAt: 1000, token: 5, durationMs: 140 };

function withClock(now, fn) {
  const original = Date.now;
  Date.now = () => now;
  try { return fn(); } finally { Date.now = original; }
}

/** What the glasses show of an image at `at`, as 4-bit levels. */
function shown(image, at) {
  return withClock(at, () => Array.from(image.withDrawsBaked().pixels, (v) => Math.min(15, (v + 8) >> 4)));
}

/** A switch at (3, 2) of a 40x20 image on a black row, flipped to `on` at 1000 or simply painted. */
function row(on, selected, animation) {
  const image = new GrayImage(40, 20, 0);
  image.drawToggleSwitch(3, 2, on, selected, animation);
  return image;
}

const lists = (image) => image.draws.filter((draw) => draw.presentation?.displayList);

test('a flipping switch ends on exactly the painted switch, either way and on a selected row or not', () => {
  for (const on of [true, false]) for (const selected of [true, false]) {
    const still = row(on, selected);
    assert.equal(lists(still).length, 0, 'no list without an animation');
    const flipping = row(on, selected, MOTION);
    assert.equal(lists(flipping).length, 1);
    assert.deepEqual(Array.from(flipping.pixels), Array.from(still.pixels), 'the pixels underneath are the new state');
    const end = MOTION.startedAt + MOTION.durationMs;
    assert.deepEqual(shown(flipping, end), shown(still, end), `on=${on} selected=${selected}`);
    assert.deepEqual(shown(flipping, end + 5000), shown(still, end));
  }
});

test('the knob starts at the other end and the lit track follows it across', () => {
  for (const selected of [true, false]) {
    const knobLevel = (on) => Math.min(15, (toggleSwitchLook(on, selected).knob + 8) >> 4);
    /** Columns of the switch whose middle row shows the knob's level, as [first, last]. */
    const knobSpan = (image, at, level) => {
      const pixels = shown(image, at), y = 2 + H / 2;
      const columns = [];
      for (let x = 0; x < W; x++) if (pixels[y * 40 + 3 + x] === level) columns.push(x);
      return [columns[0], columns[columns.length - 1]];
    };
    const turningOn = row(true, selected, MOTION);
    assert.deepEqual(knobSpan(turningOn, 1000, knobLevel(true)), [2, 13], 'still at the left end');
    const [left] = knobSpan(turningOn, 1070, knobLevel(true));
    assert.ok(left > 2 && left < 20, `half way: ${left}`);
    assert.deepEqual(knobSpan(turningOn, 1140, knobLevel(true)), [20, 31]);
    const turningOff = row(false, selected, MOTION);
    assert.deepEqual(knobSpan(turningOff, 1000, knobLevel(false)), [20, 31], 'still at the right end');
    assert.deepEqual(knobSpan(turningOff, 1140, knobLevel(false)), [2, 13]);
    // The lit track's outline reaches as far as the flip has got, from the left.
    const litOutline = Math.min(15, (toggleSwitchLook(true, selected).outline + 8) >> 4);
    const litTop = (image, at) => { const pixels = shown(image, at); let count = 0; for (let x = 0; x < W; x++) if (pixels[2 * 40 + 3 + x] === litOutline) count++; return count; };
    const widths = [1000, 1035, 1070, 1105, 1140].map((at) => litTop(turningOn, at));
    // (The top row only starts past the corner's curve, so the first steps may show none of it.)
    assert.equal(widths[0], 0);
    for (let i = 1; i < widths.length; i++) assert.ok(widths[i] >= widths[i - 1], `lit track grows: ${widths}`);
    assert.ok(widths[2] > 0 && widths[2] < widths[4] && widths[4] > 20, `lit track grows: ${widths}`);
    const receding = [1000, 1070, 1140].map((at) => litTop(turningOff, at));
    assert.ok(receding[0] > receding[1] && receding[1] > receding[2] && receding[2] === 0, `lit track recedes: ${receding}`);
  }
});

test('the flip is one clear, the two tracks and the knob, on a timeline that survives the bridge', () => {
  const list = toggleSwitchList(true, false, MOTION);
  assert.deepEqual(list.calls.map((call) => call.op), [DrawOp.CLEAR, DrawOp.ROUNDED_RECT, DrawOp.ROUNDED_RECT, DrawOp.ROUNDED_RECT]);
  assert.deepEqual(list.timeline, { token: 5, startedAt: 1000 });
  assert.equal(list.calls[2].clip.animated, true, 'the lit track shows through a clip that widens');
  const placed = { displayList: list, x: 3, y: 2, width: W, height: H, depth: 0 };
  const decoded = readDisplayList(encodeDisplayList(placed, 1050), 0, 1050).placed.displayList;
  assert.equal(decoded.calls.length, 4);
  assert.equal(decoded.timeline.startedAt, 1000);
});

/** Transpile one module with its imports resolved from `deps`. */
function load(file, deps) {
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { exports, console, Date, Map, require(name) {
    assert.ok(name in deps, `Unexpected import ${name} in ${file}`);
    return deps[name];
  } });
  return exports;
}

function loadMenu(speed = 'normal') {
  const font = { lineHeight: 12, ascent: 9, descent: 3, measureText: (text) => text.length * 6, drawText() {} };
  return load('app/ui/menu.ts', {
    '../graphics/image': build('graphics/image'), '../graphics/textwrap': build('graphics/textwrap'),
    '../graphics/ui-fonts': { getDefaultSmallFont: () => font }, '../graphics/screen-size': { screenWidth: () => 640, screenHeight: () => 480 },
    '../native/settings-store': { getStringSetting: () => speed }, '../util/numeric-util': build('util/numeric-util'),
    './animation-speed': build('ui/animation-speed'), './layers': {}, './menu-animation-pref': build('ui/menu-animation-pref'),
    './menu-core': build('ui/menu-core'), './gestures': build('ui/gestures'), './metrics': build('ui/metrics'),
  });
}

test('a keyed toggle row animates when its value changes between paints, and only then', () => {
  const { drawToggleMenuItem } = loadMenu();
  const font = { lineHeight: 12, ascent: 9, descent: 3, measureText: () => 0, drawText() {} };
  const paint = (now, on, key) => withClock(now, () => {
    const image = new GrayImage(120, 20, 0);
    drawToggleMenuItem(image, font, 4, 2, 110, 'Label', on, true, key);
    return image;
  });
  assert.equal(lists(paint(1000, false, 'a')).length, 0, 'a first paint shows the state');
  assert.equal(lists(paint(2000, false, 'a')).length, 0, 'unchanged');
  const flipped = paint(3000, true, 'a');
  assert.equal(lists(flipped).length, 1, 'flipped since the last paint');
  const { displayList } = lists(flipped)[0].presentation;
  assert.equal(displayList.timeline.startedAt, 3000);
  // Repaints during the flip carry the same timeline; once it is over the row is plain again.
  const again = lists(paint(3050, true, 'a'))[0].presentation.displayList;
  assert.deepEqual(again.timeline, displayList.timeline);
  assert.equal(lists(paint(3000 + 140, true, 'a')).length, 0);
  // Another toggle, and rows without a key, are unaffected.
  assert.equal(lists(paint(3010, true, 'b')).length, 0);
  assert.equal(lists(paint(4000, false)).length, 0);
  assert.equal(lists(paint(4010, true)).length, 0);
  // Flipping back starts a new timeline.
  const back = lists(paint(5000, false, 'a'))[0].presentation.displayList;
  assert.notEqual(back.timeline.token, displayList.timeline.token);
  // The switch sits where it always has, at the row's right edge.
  const still = paint(9000, false, 'a');
  const expected = new GrayImage(120, 20, 0);
  expected.drawToggleSwitch(4 + 110 - W - 2, 2 + 1, false, true);
  assert.deepEqual(Array.from(still.pixels), Array.from(expected.pixels));
});

test('with menu animation disabled a toggle snaps', () => {
  const { drawToggleMenuItem } = loadMenu('disabled');
  const font = { lineHeight: 12, ascent: 9, descent: 3, measureText: () => 0, drawText() {} };
  const paint = (now, on) => withClock(now, () => {
    const image = new GrayImage(120, 20, 0);
    drawToggleMenuItem(image, font, 4, 2, 110, 'Label', on, false, 'snap');
    return image;
  });
  paint(1000, false);
  assert.equal(lists(paint(2000, true)).length, 0);
});
