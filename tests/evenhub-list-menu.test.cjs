// EvenHub list containers in the stock style, on the shared Menu: dim
// unselected text, a text-sized outline, animated scrolling and bounce, and a
// selection that moves instantly.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  paintListItems, stepListSelection, listRowHeight, truncateToWidth, DESELECTED_TEXT, LIST_ITEM_PADDING_X, LIST_ITEM_PADDING_Y,
} = require("../.test-build/app/apps/evenhub/list-menu.js");
const { GrayImage } = require("../.test-build/app/graphics/image.js");
const { DrawOp } = require("../.test-build/app/graphics/display-list.js");

/** Each character is a 6x10 block of ink at 10px advance. */
const font = {
  lineHeight: 20,
  measureLine: (text) => text.length * 10,
  drawText: (image, x, y, text, value = 255) => {
    for (let i = 0; i < text.length; i++) image.fillRect(x + i * 10, y + 4, 6, 10, value);
  },
};

function list(itemNames, height) {
  return {
    kind: "list", id: 1, name: "list", x: 0, y: 0, width: 200, height,
    borderWidth: 0, borderRadius: 0, paddingLength: 0, isEventCapture: true, zOrderIndex: undefined,
    preserve: false, itemNames, itemWidth: 0, selectBorder: true, selectedIndex: 0,
  };
}

function paint(container, now, focused = true) {
  const original = Date.now;
  Date.now = () => now;
  try {
    const image = new GrayImage(200, 200, 0);
    paintListItems(image, container, font, focused);
    return image;
  } finally {
    Date.now = original;
  }
}

const displayLists = (image) => image.draws.map((draw) => draw.presentation?.displayList).filter(Boolean);
const pixel = (image, x, y) => image.withDrawsBaked().pixels[y * image.width + x];

test("the unfocused outline is dimmer", () => {
  const image = paint(list(["ab"], 100), 1000, false);
  assert.equal(pixel(image, 0, 16), 130);
});

test("selection within the viewport changes instantly, with no animation", () => {
  const container = list(["a", "b", "c", "d", "e", "f"], 128);
  paint(container, 1000);
  assert.equal(stepListSelection(container, font, 1), true);
  assert.equal(container.selectedIndex, 1);
  const image = paint(container, 2000);
  assert.deepEqual(displayLists(image), []);
});

test("navigation that scrolls animates a strip", () => {
  const container = list(["a", "b", "c", "d", "e", "f"], 128);
  paint(container, 1000);
  for (let i = 0; i < 3; i++) {
    stepListSelection(container, font, 1);
    paint(container, 1000 + i);
  }
  assert.equal(container.selectedIndex, 3);
  const scrolled = displayLists(paint(container, 5000));
  assert.deepEqual(scrolled, [], "settled paints don't animate");
  stepListSelection(container, font, 1);
  const [strip] = displayLists(paint(container, 6000));
  assert.ok(strip?.calls.some((call) => call.op === DrawOp.RECT_COPY), "the scroll animates");
  assert.ok(!strip.calls.some((call) => call.op === DrawOp.ROUNDED_RECT), "no separate sliding highlight");
});

test("stepping past an end keeps the selection and bounces", () => {
  const container = list(["a", "b", "c", "d", "e", "f"], 128);
  paint(container, 1000);
  assert.equal(stepListSelection(container, font, -1), false);
  assert.equal(container.selectedIndex, 0);
  const [bounce] = displayLists(paint(container, 2000));
  assert.ok(bounce?.calls.some((call) => call.op === DrawOp.RECT_COPY), "the list bounces");
});

test("a row cut by the bottom edge is drawn clipped", () => {
  // 100px fits three 32px rows and the top 4px of the fourth, whose ink
  // starts 10px into the row, so a 16px taller box shows its first 10 lines.
  const clipped = paint(list(["a", "b", "c", "d"], 100), 1000);
  const textTop = 3 * 32 + LIST_ITEM_PADDING_Y + 4;
  assert.equal(pixel(clipped, LIST_ITEM_PADDING_X, textTop), 0, "below the edge");
  const partial = paint(list(["a", "b", "c", "d"], 3 * 32 + 16), 1000);
  assert.equal(pixel(partial, LIST_ITEM_PADDING_X, 3 * 32 + 16), 0, "nothing past the edge");
  assert.equal(pixel(partial, LIST_ITEM_PADDING_X, textTop), DESELECTED_TEXT, "the visible part is drawn");
});

test("at the end of a list with a partial row, the top row stays whole", () => {
  const container = list(["a", "b", "c", "d", "e"], 3 * 32 + 16);
  paint(container, 1000);
  for (let i = 0; i < 4; i++) {
    stepListSelection(container, font, 1);
    paint(container, 1000 + i);
  }
  const image = paint(container, 9000);
  // As in every Menu, the viewport never starts on a partial row: c, d and
  // e show whole, leaving 16px empty below e rather than cutting c in half.
  assert.equal(pixel(image, LIST_ITEM_PADDING_X, LIST_ITEM_PADDING_Y + 4), DESELECTED_TEXT, "c at the top");
  assert.equal(pixel(image, LIST_ITEM_PADDING_X, 64 + LIST_ITEM_PADDING_Y + 4), 255, "e selected, third row");
});

test("with the selection border off, the selected item has no outline", () => {
  const container = { ...list(["ab"], 100), selectBorder: false };
  const image = paint(container, 1000);
  assert.equal(pixel(image, 0, 16), 0, "no outline edge");
  assert.equal(pixel(image, LIST_ITEM_PADDING_X, LIST_ITEM_PADDING_Y + 4), 255, "text still selected-bright");
});

test("a fixed itemWidth sets the outline's width exactly", () => {
  const container = { ...list(["ab"], 100), itemWidth: 150 };
  const image = paint(container, 1000);
  assert.equal(pixel(image, 149, 16), 255, "right edge at itemWidth");
  assert.equal(pixel(image, 150, 16), 0);
});

test("text wider than a fixed itemWidth is truncated with an ellipsis", () => {
  // 10px per char: 100 - 2 * 12 = 76px holds "abcd..." (70px) but not "abcde..." (80px).
  assert.equal(truncateToWidth(font, "abcdefghij", 76), "abcd...");
  assert.equal(truncateToWidth(font, "abcdefg", 76), "abcdefg", "fits: unchanged");
  assert.equal(truncateToWidth(font, "abcdefgh", 20), "...", "room for nothing but the ellipsis");
  const drawn = [];
  const recording = { ...font, drawText: (image, x, y, text, value) => { drawn.push(text); font.drawText(image, x, y, text, value); } };
  const image = new GrayImage(200, 200, 0);
  paintListItems(image, { ...list(["abcdefghij", "ab"], 100), itemWidth: 100 }, recording, true);
  assert.deepEqual(drawn, ["abcd...", "ab"]);
});
