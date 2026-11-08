// The Even phone app's checks before it sends a page or text upgrade to the
// glasses (app/apps/evenhub/payload-validation.ts).
const test = require("node:test");
const assert = require("node:assert/strict");

const { stockPayloadError } = require("../.test-build/app/apps/evenhub/payload-validation.js");

// What SDK 0.0.16 sends for a small page (captured with a stub bridge).
const sdkPage = () => ({
  containerTotalNum: 2,
  textObject: [{ containerID: 1, containerName: "t", xPosition: 0, yPosition: 0, width: 200, height: 100, content: "hi", isEventCapture: 1, borderWidth: 2 }],
  imageObject: [{ containerID: 2, containerName: "i", xPosition: 0, yPosition: 0, width: 40, height: 40 }],
  listObject: [{ containerID: 3, containerName: "l", itemContainer: { itemCount: 2, itemName: ["a", "b"], isItemSelectBorderEn: 1 } }],
  menuObject: { menuItems: [{ itemName: "Pause", itemID: 1 }] },
});

test("SDK-shaped payloads pass", () => {
  assert.equal(stockPayloadError("create", sdkPage()), null);
  assert.equal(stockPayloadError("rebuild", sdkPage()), null);
  assert.equal(stockPayloadError("textUpgrade", { containerID: 1, containerName: "t", contentOffset: 2, contentLength: 3, content: "abc" }), null);
});

test("unknown keys fail, numeric tag keys pass", () => {
  const page = sdkPage();
  page.textObject[0].Container_ID = 1;
  assert.match(stockPayloadError("create", page), /unknown key textObject\[0\]\.Container_ID/);
  assert.match(stockPayloadError("rebuild", { ...sdkPage(), widgetId: 1 }), /unknown key widgetId/);
  assert.equal(stockPayloadError("create", { ...sdkPage(), 7: 1 }), null);
});

test("numeric fields take integers or numeric strings only", () => {
  const withField = (value) => {
    const page = sdkPage();
    page.textObject[0].xPosition = value;
    return stockPayloadError("create", page);
  };
  assert.equal(withField(-10), null, "negative values wrap rather than fail");
  assert.equal(withField("12"), null);
  assert.match(withField(10.5), /must be an integer/);
  assert.match(withField(true), /must be an integer/);
  assert.match(withField(null), /is null/);
  assert.match(withField("left"), /must be an integer/);
});

test("string and repeated fields are type-checked", () => {
  const page = sdkPage();
  page.textObject[0].content = 5;
  assert.match(stockPayloadError("create", page), /content must be a string/);
  const list = sdkPage();
  list.listObject[0].itemContainer.itemName = "a";
  assert.match(stockPayloadError("create", list), /itemName must be an array/);
});

test("textColor must be an integer 0..4 wherever it appears", () => {
  const page = sdkPage();
  page.textObject[0].textColor = 4;
  assert.equal(stockPayloadError("create", page), null);
  page.textObject[0].textColor = 15;
  assert.match(stockPayloadError("create", page), /textColor must be an integer from 0 to 4/);
  assert.match(stockPayloadError("textUpgrade", { containerID: 1, content: "x", textColor: "3" }), /textColor/);
});
