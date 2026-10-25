// Font options for EvenHub text and list containers (extension layouts):
// parsing, layout-default inheritance, and choosing a face.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseFontSpec,
  mergeFontSpecs,
  selectFontFace,
  describeFontFamilies,
  MAX_FONT_SIZE,
} = require("../.test-build/app/apps/evenhub/font-spec.js");

const TERMINUS_SIZES = [12, 14, 16, 18, 20, 22, 24, 28, 32];
const ttf = (family, weight, monospace = false) => ({ family, weight, sizes: null, monospace, key: `ttf:${family}:${weight}` });
const FACES = [
  { family: "EvenHub", weight: 400, sizes: [20], monospace: false, key: "stock" },
  { family: "Terminus", weight: 400, sizes: TERMINUS_SIZES, monospace: true, key: "terminus:400" },
  { family: "Terminus", weight: 700, sizes: TERMINUS_SIZES, monospace: true, key: "terminus:700" },
  ttf("Inter 18pt", 300), ttf("Inter 18pt", 400), ttf("Inter 18pt", 700),
  ttf("Roboto", 300), ttf("Roboto", 400), ttf("Roboto", 700),
  ttf("Roboto Mono", 300, true), ttf("Roboto Mono", 400, true), ttf("Roboto Mono", 700, true),
];
const pick = (spec, faces = FACES) => {
  const choice = selectFontFace(spec, faces);
  return choice && `${choice.face.key}@${choice.size}`;
};

test("no font object means no spec (the stock font); an empty one means the defaults", () => {
  assert.equal(parseFontSpec(undefined), undefined);
  assert.equal(parseFontSpec("Roboto"), undefined);
  assert.deepEqual(parseFontSpec({}), {});
  assert.equal(pick({}), "ttf:Roboto:400@20");
});

test("sizes are rounded and clamped, weights take keywords and numeric strings", () => {
  assert.deepEqual(parseFontSpec({ family: " Inter ", size: 17.6, weight: "bold" }), { family: "Inter", size: 18, weight: 700 });
  assert.deepEqual(parseFontSpec({ size: 1000, weight: "normal" }), { size: MAX_FONT_SIZE, weight: 400 });
  assert.deepEqual(parseFontSpec({ size: 2, weight: "300" }), { size: 6, weight: 300 });
  assert.deepEqual(parseFontSpec({ family: "", size: "x", weight: "heavy" }), {});
});

test("a container's font overrides the layout default field by field", () => {
  assert.deepEqual(mergeFontSpecs({ family: "Inter", size: 24 }, { size: 30 }), { family: "Inter", size: 30 });
  assert.deepEqual(mergeFontSpecs(undefined, { size: 30 }), { size: 30 });
  assert.deepEqual(mergeFontSpecs({ family: "Inter" }, undefined), { family: "Inter" });
  assert.equal(mergeFontSpecs(undefined, undefined), undefined);
});

test("families match loosely, including without an optical-size suffix", () => {
  assert.equal(pick({ family: "inter" }), "ttf:Inter 18pt:400@20");
  assert.equal(pick({ family: "Inter 18pt" }), "ttf:Inter 18pt:400@20");
  assert.equal(pick({ family: "robotomono", size: 14 }), "ttf:Roboto Mono:400@14");
  assert.equal(pick({ family: "ROBOTO" }), "ttf:Roboto:400@20", "Roboto doesn't pick up Roboto Mono");
});

test("an unknown family falls back to Roboto, and with no Roboto there is no choice", () => {
  assert.equal(pick({ family: "Comic Sans", weight: 700 }), "ttf:Roboto:700@20");
  assert.equal(pick({ family: "Comic Sans" }, FACES.slice(0, 3)), null);
});

test("weights follow CSS matching", () => {
  assert.equal(pick({ family: "Inter", weight: 500 }), "ttf:Inter 18pt:400@20", "400-500 look lighter before heavier");
  assert.equal(pick({ family: "Inter", weight: 600 }), "ttf:Inter 18pt:700@20", "heavier requests look heavier first");
  assert.equal(pick({ family: "Inter", weight: 350 }), "ttf:Inter 18pt:300@20", "lighter requests look lighter first");
  assert.equal(pick({ family: "Inter", weight: 100 }), "ttf:Inter 18pt:300@20");
  assert.equal(pick({ family: "Inter", weight: 900 }), "ttf:Inter 18pt:700@20");
});

test("bitmap families snap to their nearest size", () => {
  assert.equal(pick({ family: "Terminus", size: 25 }), "terminus:400@24");
  assert.equal(pick({ family: "Terminus", size: 26, weight: 700 }), "terminus:700@24", "a tie takes the smaller size");
  assert.equal(pick({ family: "Terminus", size: 100 }), "terminus:400@32");
  assert.equal(pick({ family: "EvenHub", size: 40, weight: 700 }), "stock@20");
});

test("families are listed once each, by their app-facing name", () => {
  const families = describeFontFamilies(FACES);
  assert.deepEqual(families.map((f) => f.family), ["EvenHub", "Inter", "Roboto", "Roboto Mono", "Terminus"]);
  const terminus = families.find((f) => f.family === "Terminus");
  assert.deepEqual(terminus, { family: "Terminus", weights: [400, 700], sizes: TERMINUS_SIZES, monospace: true });
  const inter = families.find((f) => f.family === "Inter");
  assert.deepEqual(inter, { family: "Inter", weights: [300, 400, 700], monospace: false });
});
