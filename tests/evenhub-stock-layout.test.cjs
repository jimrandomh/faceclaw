// Stock container-model rules the EvenHub emulation follows: stacking order,
// which container captures input, id resolution, firmware clamps and border
// greys. Source: the evenRealities-openCFW reconstruction of firmware 2.2.6.10
// (evenhub_ui_containers.c, evenhub_ui_page.c, common_text/list_container.c).
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  borderGrey,
  clampToStockLimits,
  containerById,
  eventCaptureContainer,
  paintOrder,
  parsePage,
} = require("../.test-build/app/apps/evenhub/containers.js");

const names = (containers) => containers.map((c) => c.name);

test("without zOrderIndex containers stack lists, then texts, then images", () => {
  const page = parsePage({
    imageObject: [{ containerID: 1, containerName: "img" }],
    textObject: [{ containerID: 2, containerName: "txt" }],
    listObject: [{ containerID: 3, containerName: "lst" }],
  });
  assert.deepEqual(names(paintOrder(page.containers)), ["lst", "txt", "img"]);
});

test("zOrderIndex sorts only when every container has one", () => {
  const all = parsePage({
    textObject: [{ containerID: 1, containerName: "body", zOrderIndex: 2 }],
    imageObject: [{ containerID: 2, containerName: "icon", zOrderIndex: 1 }],
  });
  assert.deepEqual(names(paintOrder(all.containers)), ["icon", "body"]);
  const some = parsePage({
    textObject: [{ containerID: 1, containerName: "body", zOrderIndex: 2 }],
    imageObject: [{ containerID: 2, containerName: "icon" }],
  });
  assert.deepEqual(names(paintOrder(some.containers)), ["body", "icon"]);
});

test("the first capture container in stacking order owns input", () => {
  const page = parsePage({
    textObject: [
      { containerID: 1, containerName: "a", isEventCapture: 1, zOrderIndex: 5 },
      { containerID: 2, containerName: "b", isEventCapture: 1, zOrderIndex: 3 },
    ],
  });
  assert.equal(eventCaptureContainer(page).name, "b");
});

test("an id resolves to its first container in stacking order, whatever the kind", () => {
  const page = parsePage({
    textObject: [{ containerID: 7, containerName: "label" }],
    imageObject: [{ containerID: 7, containerName: "icon" }],
  });
  assert.equal(containerById(page, 7).kind, "text");
  assert.equal(containerById(page, 8), undefined);
});

test("stock clamps text and list geometry but leaves image sizes alone", () => {
  const page = parsePage({
    textObject: [{ containerID: 1, containerName: "t", xPosition: 900, yPosition: 400, width: 800, height: 400, borderColor: 40, borderRadius: 30, paddingLength: 50 }],
    listObject: [{ containerID: 2, containerName: "l", itemContainer: { itemName: Array.from({ length: 25 }, (_, i) => `item ${i}`) } }],
    imageObject: [{ containerID: 3, containerName: "i", xPosition: 600, width: 400, height: 200 }],
  });
  clampToStockLimits(page);
  const [list, text, image] = page.containers;
  assert.deepEqual([text.x, text.y, text.width, text.height], [576, 288, 576, 288]);
  assert.deepEqual([text.borderColor, text.borderRadius, text.paddingLength], [16, 10, 32]);
  assert.equal(list.itemNames.length, 20);
  assert.deepEqual([image.x, image.width, image.height], [576, 400, 200]);
});

test("border color indices are 16 grey steps, with 16 meaning white", () => {
  assert.equal(borderGrey(0), 0);
  assert.equal(borderGrey(3), 0x33);
  assert.equal(borderGrey(15), 0xff);
  assert.equal(borderGrey(16), 0xff);
  const page = parsePage({ textObject: [{ containerID: 1, containerName: "t", borderWidth: 2 }] });
  assert.equal(page.containers[0].borderColor, 0, "an omitted borderColor is the protobuf default, black");
});
