const test = require("node:test");
const assert = require("node:assert/strict");

const {
  fitVideo,
  formatMediaTime,
  videoHeightMode,
  videoRect,
} = require("../.test-build/app/apps/files/video-layout.js");

const WINDOW = { width: 576, height: 260 };
const TALL_WINDOW = { width: 576, height: 452 };
// ../g2flash/demos/badapple.mp4
const BAD_APPLE = { width: 1444, height: 1080 };

test("fixed sizes fit their box and keep the aspect ratio", () => {
  assert.deepEqual(videoRect("small", BAD_APPLE, WINDOW), { x: 208, y: 70, width: 160, height: 120 });
  assert.deepEqual(videoRect("medium", BAD_APPLE, WINDOW), { x: 168, y: 40, width: 240, height: 180 });
  const wide = videoRect("small", { width: 1920, height: 1080 }, WINDOW);
  assert.equal(wide.width, 160);
  assert.equal(wide.height, 90);
});

test("large fills the window height; full screen fills the tall window's width", () => {
  assert.deepEqual(videoRect("large", BAD_APPLE, WINDOW), { x: 112, y: 0, width: 348, height: 260 });
  assert.deepEqual(videoRect("full", BAD_APPLE, TALL_WINDOW), { x: 0, y: 10, width: 576, height: 430 });
  assert.equal(videoHeightMode("full"), "max");
  assert.equal(videoHeightMode("large"), "min");
});

test("rects are aligned for the delta encoder and stay inside the viewport", () => {
  for (const size of ["small", "medium", "large", "full"]) {
    for (const video of [BAD_APPLE, { width: 1080, height: 1920 }, { width: 100, height: 20 }, { width: 7, height: 5 }]) {
      for (const viewport of [WINDOW, TALL_WINDOW, { width: 150, height: 100 }]) {
        const rect = videoRect(size, video, viewport);
        const where = `${size} ${video.width}x${video.height} in ${viewport.width}x${viewport.height}`;
        assert.equal(rect.x % 4, 0, where);
        assert.equal(rect.y % 2, 0, where);
        assert.equal(rect.width % 2, 0, where);
        assert.equal(rect.height % 2, 0, where);
        assert.ok(rect.width >= 2 && rect.height >= 2, where);
        assert.ok(rect.x + rect.width <= viewport.width, where);
        assert.ok(rect.y + rect.height <= viewport.height, where);
      }
    }
  }
});

test("a tiny video is scaled up to the chosen size", () => {
  assert.deepEqual(fitVideo({ width: 80, height: 60 }, { width: 240, height: 180 }), { width: 240, height: 180 });
});

test("media times", () => {
  assert.equal(formatMediaTime(0), "0:00");
  assert.equal(formatMediaTime(232_130), "3:52");
  assert.equal(formatMediaTime(3_723_000), "1:02:03");
});
