// The EvenHub layout debug log: the stock container-order rules it compares
// our paint order against (from the evenRealities-openCFW reconstruction of
// evenhub_ui_containers.c), and the stock notes it attaches to updates.
const test = require("node:test");
const assert = require("node:assert/strict");

const { parsePage, paintOrder } = require("../.test-build/app/apps/evenhub/containers.js");
const {
  describeImageUpdate,
  describePage,
  stockDifferences,
  stockPaintOrder,
} = require("../.test-build/app/apps/evenhub/layout-debug.js");

const names = (containers) => containers.map((c) => c.name);

const iconOverBody = (extra = {}) =>
  parsePage({
    containerTotalNum: 2,
    textObject: [{ containerID: 1, containerName: "body", xPosition: 0, yPosition: 0, width: 576, height: 288, isEventCapture: 1, ...extra.text }],
    imageObject: [{ containerID: 2, containerName: "icon", xPosition: 8, yPosition: 8, width: 24, height: 24, ...extra.image }],
  });

test("without zOrderIndex, stock orders lists, then texts, then images", () => {
  const page = parsePage({
    imageObject: [{ containerID: 1, containerName: "img" }],
    textObject: [{ containerID: 2, containerName: "txt" }],
    listObject: [{ containerID: 3, containerName: "lst" }],
  });
  assert.deepEqual(names(stockPaintOrder(page.containers)), ["lst", "txt", "img"]);
  // ...where we put images at the bottom.
  assert.deepEqual(names(paintOrder(page.containers)), ["img", "lst", "txt"]);
});

test("stock sorts by zOrderIndex only when every container has one", () => {
  const all = iconOverBody({ text: { zOrderIndex: 2 }, image: { zOrderIndex: 1 } });
  assert.deepEqual(names(stockPaintOrder(all.containers)), ["icon", "body"]);
  assert.deepEqual(names(paintOrder(all.containers)), ["icon", "body"]);

  const some = iconOverBody({ text: { zOrderIndex: 2 } });
  assert.deepEqual(names(stockPaintOrder(some.containers)), ["body", "icon"]);
  assert.deepEqual(names(paintOrder(some.containers)), ["icon", "body"]);
  assert.ok(stockDifferences(some).some((note) => note.includes("zOrderIndex is set on 1 of 2")));
});

test("an image overlapping text is flagged when the two orders disagree", () => {
  const notes = stockDifferences(iconOverBody());
  assert.ok(notes.some((note) => note.startsWith("paint order differs")));
  assert.ok(notes.includes('image#2 "icon" overlaps text#1 "body": we draw text#1 "body" on top, stock draws image#2 "icon" on top'));
});

test("non-overlapping containers in a different order raise no overlap note", () => {
  const notes = stockDifferences(iconOverBody({ text: { yPosition: 100, height: 100 } }));
  assert.ok(!notes.some((note) => note.includes("overlaps")));
});

test("image containers outside stock's size limits are flagged", () => {
  const notes = stockDifferences(iconOverBody({ image: { width: 16, height: 16 } }));
  assert.ok(notes.some((note) => note.includes("16x16") && note.includes("fails the whole page")));
});

test("a shared container id resolves to the first container in stock order", () => {
  const page = iconOverBody({ image: { containerID: 1 } });
  assert.ok(stockDifferences(page).includes('id 1 is shared by text#1 "body", image#1 "icon"; stock resolves it to text#1 "body" only'));
  const lines = describeImageUpdate({
    page,
    sentId: 1,
    sentName: "",
    container: page.containers.find((c) => c.kind === "image"),
    raw: [],
    bytes: null,
    decoded: null,
    result: 1,
  });
  assert.ok(lines.some((line) => line.includes("stock drops this update")));
});

test("image updates note base64 payloads, size mismatches and blank images", () => {
  const page = iconOverBody();
  const icon = page.containers.find((c) => c.kind === "image");
  const lines = describeImageUpdate({
    page,
    sentId: 2,
    sentName: "icon",
    container: icon,
    raw: "AAAA",
    bytes: new Uint8Array(3),
    decoded: { pixels: new Uint8Array(4), width: 2, height: 2 },
    result: 0,
  });
  assert.match(lines[0], /payload=string\(4 chars\)/);
  assert.match(lines[0], /decoded=2x2 blank/);
  assert.ok(lines.some((line) => line.includes("base64-string")));
  assert.ok(lines.some((line) => line.includes("exactly the container's size (24x24)")));
});

test("lit pixels are summarized with a bounding box", () => {
  const page = iconOverBody();
  const icon = page.containers.find((c) => c.kind === "image");
  const pixels = new Uint8Array(24 * 24);
  pixels[24 * 3 + 5] = 200;
  pixels[24 * 10 + 7] = 255;
  const [first] = describeImageUpdate({
    page,
    sentId: 2,
    sentName: "",
    container: icon,
    raw: Array.from(pixels),
    bytes: pixels,
    decoded: { pixels, width: 24, height: 24 },
    result: 0,
  });
  assert.match(first, /format=raw8 decoded=24x24 lit=2px max=255 bbox=5,3-7,10 result=0$/);
});

test("describePage lists containers bottom to top and ends with the raw payload", () => {
  const lines = describePage("rebuildPageContainer", iconOverBody(), { containerTotalNum: 2 });
  assert.match(lines[0], /^rebuildPageContainer: 2 containers \(0 list, 1 text, 1 image\), containerTotalNum=2/);
  assert.match(lines[1], /^ {2}0: image#2 "icon" @8,8 24x24 no pixels yet$/);
  assert.match(lines[2], /^ {2}1: text#1 "body" @0,0 576x288 capture len=0 ""$/);
  assert.equal(lines.at(-1), '  raw: {"containerTotalNum":2}');
});
