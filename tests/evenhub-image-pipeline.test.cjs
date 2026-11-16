// updateImageRawData conversion (app/apps/evenhub/image-pipeline.ts), checked
// against what the Even phone app's decompiled _prepare / _prepareLegacyRaw do.
const test = require("node:test");
const assert = require("node:assert/strict");
const UPNG = require("upng-js");

const {
  IMAGE_EXCEPTION,
  IMAGE_SEND_FAILED,
  IMAGE_SIZE_INVALID,
  IMAGE_SUCCESS,
  detectImageFormat,
  grayLevel,
  prepareImageUpdate,
  resizeRgbaCover,
} = require("../.test-build/app/apps/evenhub/image-pipeline.js");

const noNative = () => null;
const request = (over) => ({
  imageData: [],
  compressMode: 2,
  requestWidth: 0,
  requestHeight: 0,
  geometry: { width: 20, height: 20 },
  decodeNative: noNative,
  stockLimits: true,
  ...over,
});

/** A PNG of the given RGBA pixels. */
function png(width, height, rgba) {
  return Array.from(new Uint8Array(UPNG.encode([Uint8Array.from(rgba).buffer], width, height, 0)));
}

test("imageData must be an array of integers", () => {
  assert.equal(prepareImageUpdate(request({ imageData: "AAAA" })).result, IMAGE_SEND_FAILED);
  assert.equal(prepareImageUpdate(request({ imageData: { 0: 1, 1: 2 } })).result, IMAGE_SEND_FAILED);
  assert.equal(prepareImageUpdate(request({ imageData: [1, 2.5] })).result, IMAGE_SEND_FAILED);
});

test("formats are recognized by their magic bytes", () => {
  assert.equal(detectImageFormat(Uint8Array.from(png(1, 1, [0, 0, 0, 255]))), "png");
  assert.equal(detectImageFormat(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "jpeg");
  assert.equal(detectImageFormat(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), "webp");
  assert.equal(detectImageFormat(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), "gif");
  assert.equal(detectImageFormat(Uint8Array.from([0x42, 0x4d, 0, 0])), "bmp");
  assert.equal(detectImageFormat(Uint8Array.from([1, 2, 3])), "raw");
});

test("grey uses 299/587/114 weights rounded to 16 levels, ignoring alpha", () => {
  assert.equal(grayLevel(255, 0, 0), 4);
  assert.equal(grayLevel(255, 255, 255), 15);
  assert.equal(grayLevel(0, 0, 0), 0);
  // A transparent white pixel is white: the phone app never looks at alpha.
  const result = prepareImageUpdate(request({ imageData: png(20, 20, new Array(20 * 20).fill([255, 255, 255, 0]).flat()) }));
  assert.equal(result.result, IMAGE_SUCCESS);
  assert.ok(result.levels.every((level) => level === 15));
});

test("an encoded image is scaled to cover the container and centre-cropped", () => {
  // 4x2: columns 0..3 lit 0, 85, 170, 255. Covering 20x20 scales by 10 to
  // 40x20 and crops 10px a side, so only columns 1 and 2 survive.
  const row = [0, 85, 170, 255].flatMap((v) => [v, v, v, 255]);
  const result = prepareImageUpdate(request({ imageData: png(4, 2, [...row, ...row]) }));
  assert.equal(result.result, IMAGE_SUCCESS);
  assert.deepEqual([result.width, result.height], [20, 20]);
  assert.deepEqual(Array.from(result.levels.slice(0, 20)), [...new Array(10).fill(grayLevel(85, 85, 85)), ...new Array(10).fill(grayLevel(170, 170, 170))]);
});

test("the cover resize samples source pixel centres", () => {
  const source = { width: 3, height: 1, rgba: Uint8Array.from([10, 0, 0, 0, 20, 0, 0, 0, 30, 0, 0, 0]) };
  const wide = resizeRgbaCover(source, 6, 2);
  assert.deepEqual(Array.from(wide.rgba.filter((_, i) => i % 4 === 0)), [10, 10, 20, 20, 30, 30, 10, 10, 20, 20, 30, 30]);
});

test("width and height sent with the update replace the container's", () => {
  const black = new Array(30 * 30).fill([0, 0, 0, 255]).flat();
  const result = prepareImageUpdate(request({ imageData: png(30, 30, black), requestWidth: 40, requestHeight: 25 }));
  assert.deepEqual([result.width, result.height], [40, 25]);
});

test("without a usable container size, the decoded size must itself be in range", () => {
  const tiny = new Array(10 * 10).fill([0, 0, 0, 255]).flat();
  assert.equal(prepareImageUpdate(request({ imageData: png(10, 10, tiny), geometry: null })).result, IMAGE_SIZE_INVALID);
});

test("JPEG, WebP and GIF go to the native decoder; a failed decode is an exception", () => {
  const jpeg = [0xff, 0xd8, 0xff, 0xe0];
  const decoded = prepareImageUpdate(request({
    imageData: jpeg,
    decodeNative: () => ({ width: 20, height: 20, rgba: new Uint8Array(20 * 20 * 4).fill(255) }),
  }));
  assert.equal(decoded.result, IMAGE_SUCCESS);
  assert.equal(decoded.format, "jpeg");
  assert.equal(prepareImageUpdate(request({ imageData: jpeg })).result, IMAGE_EXCEPTION);
});

test("raw pixels need compressMode 2 and exactly the container's size", () => {
  const raw = new Array(400).fill(0);
  assert.equal(prepareImageUpdate(request({ imageData: raw })).result, IMAGE_SUCCESS);
  assert.equal(prepareImageUpdate(request({ imageData: raw, compressMode: 0 })).result, IMAGE_EXCEPTION);
  assert.equal(prepareImageUpdate(request({ imageData: raw.slice(1) })).result, IMAGE_EXCEPTION);
  assert.equal(prepareImageUpdate(request({ imageData: raw, geometry: { width: 400, height: 1 } })).result, IMAGE_SIZE_INVALID);
});

test("raw bytes up to 15 are already 4-bit levels; larger ones are 8-bit grey", () => {
  const raw = new Array(400).fill(0);
  raw.splice(0, 4, 15, 16, 128, 255);
  const { levels } = prepareImageUpdate(request({ imageData: raw }));
  assert.deepEqual(Array.from(levels.slice(0, 4)), [15, 1, 8, 15]);
});

test("4-bit raw rows are padded to whole bytes", () => {
  // 21 wide: 11 bytes a row, high nibble first, the last low nibble unused.
  const rows = [];
  for (let y = 0; y < 20; y++) rows.push(0xf0, ...new Array(9).fill(0), 0x0f << 4);
  const { result, levels } = prepareImageUpdate(request({ imageData: rows, geometry: { width: 21, height: 20 } }));
  assert.equal(result, IMAGE_SUCCESS);
  assert.deepEqual([levels[0], levels[1], levels[20], levels[21]], [15, 0, 15, 15]);
});

test("extended layouts skip the stock size and compressMode rules", () => {
  const big = new Array(400 * 200).fill(0);
  const result = prepareImageUpdate(request({ imageData: big, compressMode: 0, geometry: { width: 400, height: 200 }, stockLimits: false }));
  assert.equal(result.result, IMAGE_SUCCESS);
});
