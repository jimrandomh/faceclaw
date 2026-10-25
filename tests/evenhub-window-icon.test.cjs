// App-supplied switcher icons (extension setWindowIcon): parsing the pixel
// buffer from the bridge, and scaling it to the switcher's icon size.
const test = require("node:test");
const assert = require("node:assert/strict");

const { parseWindowIcon, WindowIconRenderer, MAX_WINDOW_ICON_DIMENSION } = require("../.test-build/app/apps/evenhub/window-icon.js");

test("grayscale data is taken as-is", () => {
  const icon = parseWindowIcon({ width: 2, height: 2, data: [0, 64, 128, 255] });
  assert.deepEqual([...icon.pixels], [0, 64, 128, 255]);
});

test("RGBA data (an ImageData) becomes luminance times alpha", () => {
  const icon = parseWindowIcon({
    width: 3,
    height: 1,
    data: [255, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 255],
  });
  assert.deepEqual([...icon.pixels], [255, 0, 182]);
});

test("a JSON-ified typed array parses like a plain array", () => {
  const icon = parseWindowIcon({ width: 2, height: 1, data: { 0: 10, 1: 20 } });
  assert.deepEqual([...icon.pixels], [10, 20]);
});

test("malformed icons are refused", () => {
  assert.equal(parseWindowIcon(null), null);
  assert.equal(parseWindowIcon({ width: 2, height: 2, data: [1, 2, 3] }), null, "wrong length");
  assert.equal(parseWindowIcon({ width: 0, height: 2, data: [] }), null, "empty");
  assert.equal(parseWindowIcon({ width: 1.5, height: 2, data: [1, 2, 3] }), null, "fractional size");
  assert.equal(parseWindowIcon({ width: 1, height: 1, data: ["x"] }), null, "non-numeric data");
  const big = MAX_WINDOW_ICON_DIMENSION + 1;
  assert.equal(parseWindowIcon({ width: big, height: 1, data: new Array(big).fill(0) }), null, "too wide");
});

test("icons shrink to fit the box, keeping their aspect ratio and averaging pixels", () => {
  const data = [];
  for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) data.push(x < 4 ? 0 : 200);
  const renderer = new WindowIconRenderer(parseWindowIcon({ width: 8, height: 4, data }));
  const small = renderer.render(4);
  assert.equal(small.width, 4);
  assert.equal(small.height, 2);
  assert.deepEqual([...small.pixels], [0, 0, 200, 200, 0, 0, 200, 200]);
  const odd = renderer.render(3);
  assert.equal(odd.width, 3);
  // The middle column straddles the edge between the halves.
  assert.equal(odd.pixels[1], 100);
});

test("renders are cached per size, and a fitting icon is used unscaled", () => {
  const source = parseWindowIcon({ width: 4, height: 4, data: new Array(16).fill(9) });
  const renderer = new WindowIconRenderer(source);
  assert.equal(renderer.render(32), renderer.render(32));
  assert.equal(renderer.render(4), source);
});
