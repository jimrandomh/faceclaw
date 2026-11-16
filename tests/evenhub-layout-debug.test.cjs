// The EvenHub layout debug log (app/apps/evenhub/layout-debug.ts): page notes
// and the per-update lines it writes to logcat.
const test = require("node:test");
const assert = require("node:assert/strict");

const { parsePage } = require("../.test-build/app/apps/evenhub/containers.js");
const { describeImageUpdate, describePage, pageNotes } = require("../.test-build/app/apps/evenhub/layout-debug.js");

const iconOverBody = (extra = {}) =>
  parsePage({
    containerTotalNum: 2,
    textObject: [{ containerID: 1, containerName: "body", xPosition: 0, yPosition: 0, width: 576, height: 288, isEventCapture: 1, ...extra.text }],
    imageObject: [{ containerID: 2, containerName: "icon", xPosition: 8, yPosition: 8, width: 24, height: 24, ...extra.image }],
  });

test("describePage lists containers bottom to top and ends with the raw payload", () => {
  const lines = describePage("rebuildPageContainer", iconOverBody(), { containerTotalNum: 2 });
  assert.match(lines[0], /^rebuildPageContainer: 2 containers \(0 list, 1 text, 1 image\), containerTotalNum=2/);
  assert.match(lines[1], /^ {2}0: text#1 "body" @0,0 576x288 capture len=0 ""$/);
  assert.match(lines[2], /^ {2}1: image#2 "icon" @8,8 24x24 no pixels yet$/);
  assert.equal(lines.at(-1), '  raw: {"containerTotalNum":2}');
});

test("a shared container id is noted with the container it resolves to", () => {
  assert.ok(pageNotes(iconOverBody({ image: { containerID: 1 } })).includes(
    'id 1 is shared by text#1 "body", image#1 "icon"; updates and events resolve to text#1 "body" only',
  ));
});

test("capture-container problems and a wrong containerTotalNum are noted", () => {
  assert.ok(pageNotes(iconOverBody({ text: { isEventCapture: 0 } })).some((n) => n.startsWith("no event-capture container")));
  assert.ok(pageNotes(iconOverBody(), 3).some((n) => n.startsWith("containerTotalNum is 3 but 2")));
  assert.deepEqual(pageNotes(iconOverBody(), 2), []);
});

const prepared = (over = {}) => ({ result: 0, levels: null, width: 0, height: 0, format: "raw", reason: "", ...over });

test("an update lists payload, size, lit pixels and outcome", () => {
  const page = iconOverBody();
  const levels = new Uint8Array(24 * 24);
  levels[24 * 3 + 5] = 9;
  levels[24 * 10 + 7] = 15;
  const [line] = describeImageUpdate({
    sentId: 2, sentName: "icon", raw: Array.from(levels), target: page.containers[1],
    prepared: prepared({ levels, width: 24, height: 24 }), shown: true, result: 0,
  });
  assert.equal(line, 'updateImageRawData id=2 "icon" -> image#2 "icon" payload=number[576] format=raw 24x24 lit=2px max=15/15 bbox=5,3-7,10 result=0 shown');
});

test("an update says why it wasn't shown", () => {
  const page = iconOverBody({ image: { containerID: 1 } });
  const toText = describeImageUpdate({
    sentId: 1, sentName: "", raw: [], target: page.containers[0],
    prepared: prepared({ levels: new Uint8Array(1), width: 1, height: 1 }), shown: false, result: 4,
  });
  assert.ok(toText.some((line) => line.includes('resolves to text#1 "body", so the glasses refuse')));
  const failed = describeImageUpdate({
    sentId: 2, sentName: "", raw: "AAAA", target: undefined,
    prepared: prepared({ result: 4, format: null, reason: "imageData is not an array of integers" }), shown: false, result: 4,
  });
  assert.match(failed[0], /payload=string\(4 chars\) result=4 not shown$/);
  assert.equal(failed[1], "  imageData is not an array of integers");
});
