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
