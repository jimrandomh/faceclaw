const test = require("node:test");
const assert = require("node:assert/strict");

const { QUADRANT_LAYOUT, resolveGlanceRegions, slotsVerticallyAdjacent } = require("../.test-build/app/apps/glanceboard/layout.js");

const spans = (choice) => choice === "terminal" || choice === "calendar";

test("quadrant adjacency: left pair and right pair stack, nothing else", () => {
  assert.equal(slotsVerticallyAdjacent(QUADRANT_LAYOUT, 0, 2), true);
  assert.equal(slotsVerticallyAdjacent(QUADRANT_LAYOUT, 3, 1), true);
  assert.equal(slotsVerticallyAdjacent(QUADRANT_LAYOUT, 0, 1), false);
  assert.equal(slotsVerticallyAdjacent(QUADRANT_LAYOUT, 0, 3), false);
  assert.equal(slotsVerticallyAdjacent(QUADRANT_LAYOUT, 1, 1), false);
});

test("a spanning widget in both left slots becomes one double-height region", () => {
  const regions = resolveGlanceRegions(QUADRANT_LAYOUT, ["terminal", "music", "terminal", "none"], spans);
  assert.deepEqual(regions, [
    { choice: "terminal", rect: { x: 0, y: 0, width: 288, height: 288 }, slots: [0, 2] },
    { choice: "music", rect: { x: 288, y: 0, width: 288, height: 144 }, slots: [1] },
  ]);
});

test("a spanning widget in both right slots merges too, in slot order", () => {
  const regions = resolveGlanceRegions(QUADRANT_LAYOUT, ["none", "calendar", "compass", "calendar"], spans);
  assert.deepEqual(regions.map((region) => [region.choice, region.slots, region.rect.height]), [
    ["calendar", [1, 3], 288],
    ["compass", [2], 144],
  ]);
});

test("a non-spanning duplicate and a diagonal duplicate stay separate regions", () => {
  const music = resolveGlanceRegions(QUADRANT_LAYOUT, ["music", "none", "music", "none"], spans);
  assert.deepEqual(music.map((region) => region.slots), [[0], [2]]);
  const diagonal = resolveGlanceRegions(QUADRANT_LAYOUT, ["terminal", "none", "none", "terminal"], spans);
  assert.deepEqual(diagonal.map((region) => region.slots), [[0], [3]]);
});

test("empty slots produce no region", () => {
  assert.deepEqual(resolveGlanceRegions(QUADRANT_LAYOUT, ["none", "none", "none", "none"], spans), []);
});

test("dividers: left edges of the right column, top edges of the bottom row, minus merged interiors", () => {
  const { slotDividers } = require("../.test-build/app/apps/glanceboard/layout.js");
  const single = resolveGlanceRegions(QUADRANT_LAYOUT, ["music", "compass", "none", "none"], spans);
  assert.deepEqual(slotDividers(QUADRANT_LAYOUT, single), [
    { x0: 288, y0: 0, x1: 288, y1: 143 },
    { x0: 0, y0: 144, x1: 287, y1: 144 },
    { x0: 288, y0: 144, x1: 288, y1: 287 },
    { x0: 288, y0: 144, x1: 575, y1: 144 },
  ]);
  // A tall Terminal on the left drops the line across the left column only.
  const tall = resolveGlanceRegions(QUADRANT_LAYOUT, ["terminal", "music", "terminal", "none"], spans);
  assert.deepEqual(slotDividers(QUADRANT_LAYOUT, tall), [
    { x0: 288, y0: 0, x1: 288, y1: 143 },
    { x0: 288, y0: 144, x1: 288, y1: 287 },
    { x0: 288, y0: 144, x1: 575, y1: 144 },
  ]);
});

test("2x3 adds a bottom row without moving or resizing the first four slots", () => {
  const { SIX_SLOT_LAYOUT } = require("../.test-build/app/apps/glanceboard/layout.js");
  assert.equal(SIX_SLOT_LAYOUT.width, 576);
  assert.equal(SIX_SLOT_LAYOUT.height, 432);
  assert.deepEqual(SIX_SLOT_LAYOUT.slots.slice(0, 4).map((slot) => slot.rect), QUADRANT_LAYOUT.slots.map((slot) => slot.rect));
  assert.deepEqual(SIX_SLOT_LAYOUT.slots.slice(4).map((slot) => slot.rect), [
    { x: 0, y: 288, width: 288, height: 144 },
    { x: 288, y: 288, width: 288, height: 144 },
  ]);
  const regions = resolveGlanceRegions(SIX_SLOT_LAYOUT, ["none", "none", "terminal", "none", "terminal", "music"], spans);
  assert.deepEqual(regions, [
    { choice: "terminal", rect: { x: 0, y: 144, width: 288, height: 288 }, slots: [2, 4] },
    { choice: "music", rect: { x: 288, y: 288, width: 288, height: 144 }, slots: [5] },
  ]);
  const { slotDividers } = require("../.test-build/app/apps/glanceboard/layout.js");
  const bottomDividers = slotDividers(SIX_SLOT_LAYOUT, regions).filter((line) => line.y0 === 288);
  assert.deepEqual(bottomDividers, [
    { x0: 288, y0: 288, x1: 288, y1: 431 },
    { x0: 288, y0: 288, x1: 575, y1: 288 },
  ]);
});

test("divider lines join across slots and grow from the point nearest the board's centre", () => {
  const { dividerLines, SIX_SLOT_LAYOUT } = require("../.test-build/app/apps/glanceboard/layout.js");
  const quadrants = resolveGlanceRegions(QUADRANT_LAYOUT, ["music", "compass", "nightscout", "health"], spans);
  assert.deepEqual(dividerLines(QUADRANT_LAYOUT, quadrants), [
    { x0: 288, y0: 0, x1: 288, y1: 287, originX: 288, originY: 144 },
    { x0: 0, y0: 144, x1: 575, y1: 144, originX: 288, originY: 144 },
  ]);
  // A tall widget on the left: the line across stops at the middle and grows out from there.
  const tall = resolveGlanceRegions(QUADRANT_LAYOUT, ["terminal", "music", "terminal", "none"], spans);
  assert.deepEqual(dividerLines(QUADRANT_LAYOUT, tall), [
    { x0: 288, y0: 0, x1: 288, y1: 287, originX: 288, originY: 144 },
    { x0: 288, y0: 144, x1: 575, y1: 144, originX: 288, originY: 144 },
  ]);
  const six = resolveGlanceRegions(SIX_SLOT_LAYOUT, ["a", "b", "c", "d", "e", "f"], () => false);
  assert.deepEqual(dividerLines(SIX_SLOT_LAYOUT, six), [
    { x0: 288, y0: 0, x1: 288, y1: 431, originX: 288, originY: 216 },
    { x0: 0, y0: 144, x1: 575, y1: 144, originX: 288, originY: 144 },
    { x0: 0, y0: 288, x1: 575, y1: 288, originX: 288, originY: 288 },
  ]);
  assert.deepEqual(dividerLines(QUADRANT_LAYOUT, []).length, 2, "empty slots still have their lines");
});

test("the dividers follow the screen fade: a point while dark, whole once shown, and then exactly the painted lines", () => {
  const { dividerLines } = require("../.test-build/app/apps/glanceboard/layout.js");
  const { dividerFadeList } = require("../.test-build/app/apps/glanceboard/divider-list.js");
  const { DrawOp, paintDisplayList } = require("../.test-build/app/graphics/display-list.js");
  const { evaluate } = require("../.test-build/app/graphics/draw-expression.js");
  const { GrayImage } = require("../.test-build/app/graphics/image.js");
  const lines = dividerLines(QUADRANT_LAYOUT, resolveGlanceRegions(QUADRANT_LAYOUT, ["terminal", "music", "terminal", "none"], spans));
  const list = dividerFadeList(lines, 1);
  assert.equal(list.timeline, undefined, "nothing is timed: the glasses redraw for as long as the fade moves");
  assert.deepEqual(list.calls.map((call) => [call.op, call.color]), [[DrawOp.LINE, 0], [DrawOp.LINE, 0], [DrawOp.LINE, 1], [DrawOp.LINE, 1]]);
  const ends = (call, fade) => [call.x0, call.y0, call.x1, call.y1].map((value) => evaluate(value, 0, 0, fade).value);
  const [vertical, across] = list.calls.slice(2);
  assert.deepEqual([ends(vertical, 0), ends(vertical, 0.5), ends(vertical, 1)], [[288, 144, 288, 144], [288, 72, 288, 215], [288, 0, 288, 287]]);
  assert.deepEqual([ends(across, 0), ends(across, 1)], [[288, 144, 288, 144], [288, 144, 575, 144]]);
  assert.ok(ends(across, 0.25)[2] < 288 + 287 / 4, "eased: slower than linear at the start");
  // The fade is the lines' only clock: no program reads time, so their speed is the fade's,
  // whatever Settings > Customization > Animations > Screen fade makes it.
  const { ExprOp } = require("../.test-build/app/graphics/draw-expression.js");
  const opcodes = (code) => {
    const found = [];
    for (let at = 0; at < code.length;) {
      const op = code[at++];
      found.push(op);
      if (op === ExprOp.F32) at += 4;
      else if (op === ExprOp.I32) at += code[at] < 0x80 ? 1 : code[at] < 0xc0 ? 2 : code[at] < 0xe0 ? 3 : code[at] < 0xf0 ? 4 : 5;
    }
    return found;
  };
  const programs = list.calls.flatMap((call) => [call.x0, call.y0, call.x1, call.y1]).filter((value) => typeof value !== "number");
  assert.ok(programs.length > 0);
  for (const program of programs) {
    const ops = opcodes(program.code);
    assert.ok(ops.includes(ExprOp.FADE));
    assert.ok(!ops.includes(ExprOp.TIME) && !ops.includes(ExprOp.ELAPSED), "nothing timed");
  }
  // Shown (as the phone always renders it), the list leaves the board's own lines as they are.
  const board = new GrayImage(576, 288, 0);
  for (const line of lines) board.drawLine(line.x0, line.y0, line.x1, line.y1, 20);
  const level = (pixels) => Array.from(pixels, (v) => Math.min(15, (v + 8) >> 4));
  const output = board.pixels.slice();
  paintDisplayList(output, board.pixels, 576, 288, { displayList: list, x: 0, y: 0, width: 576, height: 288, depth: 0 });
  assert.deepEqual(level(output), level(board.pixels));
});
