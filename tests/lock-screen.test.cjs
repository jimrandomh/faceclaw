const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');
const graphics = require('../.test-build/app/graphics/image.js');

// lock-screen.ts on a screen of the given size; the text is not drawn.
function lockScreen(width, height) {
  const font = { lineHeight: 20, measureText: (text) => text.length * 10, drawText() {} };
  const load = loader({}, {
    '../graphics/image': graphics,
    '../graphics/screen-size': { screenWidth: () => width, screenHeight: () => height },
    '../graphics/ui-fonts': { getDefaultMediumFont: () => font },
    '../graphics/textwrap': { wrapText: (_font, text) => [text] },
  });
  return load('app/g2/lock-screen.ts').createLockScreenImage();
}

// The lock surface is the screen's size, so its frame must be too.
test('the lock screen fills the paired glasses\' screen, its box centred on it', () => {
  for (const [width, height] of [[640, 480], [540, 220]]) {
    const image = lockScreen(width, height);
    assert.deepEqual([image.width, image.height], [width, height]);
    const lit = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (image.pixels[y * width + x]) lit.push([x, y]);
    const xs = lit.map(([x]) => x), ys = lit.map(([, y]) => y);
    const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    assert.deepEqual(box, [(width - 480) / 2, (height - 150) / 2, (width + 480) / 2 - 1, (height + 150) / 2 - 1], `${width}x${height}`);
  }
});
