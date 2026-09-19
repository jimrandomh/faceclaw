// The SDK 0.0.14 additions to the page-container payload: the contextual menu
// (`menuObject`) and text brightness (`textColor`).
//
// The payloads here were captured by running the real @evenrealities/
// even_hub_sdk 0.0.14 against a stub `flutter_inappwebview.callHandler` and
// recording what it sent, so they are the literal wire shapes, not a reading
// of the docs. The rules the parser enforces are the ones the SDK enforces
// app-side before it will call the host at all.
const test = require("node:test");
const assert = require("node:assert/strict");

const { parsePage, declaredMenuItems } = require("../.test-build/app/apps/evenhub/containers.js");

const menuItem = (itemID, itemName) => ({ itemName, itemID });

test("a menuObject becomes the page's contextual menu", () => {
  const page = parsePage({
    containerTotalNum: 1,
    textObject: [{ containerID: 1, containerName: "main", content: "hi" }],
    menuObject: { menuItems: [menuItem(1, "Pause"), menuItem(2, "Resume")] },
  });
  assert.deepEqual(page.menuItems, [
    { itemName: "Pause", itemID: 1 },
    { itemName: "Resume", itemID: 2 },
  ]);
});

test("a page with no menuObject has no menu, which is how rebuild clears one", () => {
  const page = parsePage({ textObject: [{ containerID: 1, containerName: "main" }] });
  assert.deepEqual(page.menuItems, []);
});

test("protobuf-style menu keys parse the same as camelCase", () => {
  const page = parsePage({ Menu_Object: { Menu_Items: [{ Item_Name: "Go", Item_ID: 3 }] } });
  assert.deepEqual(page.menuItems, [{ itemName: "Go", itemID: 3 }]);
});

test("menu entries the firmware cannot represent are dropped, not the whole page", () => {
  const page = parsePage({
    textObject: [{ containerID: 1, containerName: "main", content: "kept" }],
    menuObject: {
      menuItems: [
        menuItem(0, "zero id"),
        menuItem(1, "ok"),
        menuItem(1, "duplicate id"),
        menuItem(2, "x".repeat(33)),
        menuItem(3, "x".repeat(32)),
      ],
    },
  });
  assert.deepEqual(page.menuItems, [
    { itemName: "ok", itemID: 1 },
    { itemName: "x".repeat(32), itemID: 3 },
  ]);
  assert.equal(page.containers.length, 1, "an invalid menu must not cost the app its containers");
});

test("itemName is measured in UTF-8 bytes, not characters", () => {
  // 11 three-byte characters is 33 bytes: over the limit despite being short.
  const overLimit = "あ".repeat(11);
  const atLimit = "あ".repeat(10); // 30 bytes
  const page = parsePage({ menuObject: { menuItems: [menuItem(1, overLimit), menuItem(2, atLimit)] } });
  assert.deepEqual(page.menuItems, [{ itemName: atLimit, itemID: 2 }]);
});

test("a menu is capped at the firmware's ten entries", () => {
  const menuItems = Array.from({ length: 12 }, (_, i) => menuItem(i + 1, `item ${i + 1}`));
  const page = parsePage({ menuObject: { menuItems } });
  assert.equal(page.menuItems.length, 10);
  assert.equal(page.menuItems[9].itemID, 10);
  assert.equal(declaredMenuItems({ menuObject: { menuItems } }).length, 12, "the raw count drives the dropped-items log");
});

test("textColor carries brightness levels 0 through 4", () => {
  for (const level of [0, 1, 2, 3, 4]) {
    const page = parsePage({ textObject: [{ containerID: 1, containerName: "t", textColor: level }] });
    assert.equal(page.containers[0].textColor, level);
  }
});

test("an omitted or out-of-range textColor falls back to the device default", () => {
  for (const textObject of [
    [{ containerID: 1, containerName: "t" }],
    [{ containerID: 1, containerName: "t", textColor: 5 }],
    [{ containerID: 1, containerName: "t", textColor: -1 }],
    [{ containerID: 1, containerName: "t", textColor: 2.5 }],
  ]) {
    const page = parsePage({ textObject });
    assert.equal(page.containers[0].textColor, undefined);
  }
});
