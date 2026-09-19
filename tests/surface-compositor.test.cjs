const test = require('node:test');
const assert = require('node:assert/strict');
const { SurfaceCompositor } = require('../.test-build/app/graphics/surface-compositor.js');
const rect = (x, y, width, height) => ({ x, y, width, height });
function surface(c, id, box, values, zOrder = 0, transparency = 'opaque') {
  c.configureSurface(id, { ...box, zOrder, transparency });
  c.submitSurfaceFrame(id, Uint8Array.from(values), rect(0, 0, box.width, box.height));
}
test('shell color key preserves underlying text while opaque black covers it', () => {
  const c = new SurfaceCompositor(3, 2);
  surface(c, 'app', rect(0, 0, 3, 2), [200, 200, 200, 200, 200, 200]);
  surface(c, 'shell', rect(0, 0, 3, 2), [0, 1, 255, 0, 0, 0], 1, 'color-key');
  c.setUnderlayDim(1, 0.5);
  assert.deepEqual([...c.composite()], [100, 1, 255, 100, 100, 100]);
  c.setSurfaceVisible('shell', false);
  assert.deepEqual([...c.composite()], [100, 100, 100, 100, 100, 100]);
  surface(c, 'opaque', rect(1, 0, 1, 2), [0, 0], 2);
  assert.deepEqual([...c.composite()], [100, 0, 100, 100, 0, 100]);
});
test('partial frames clip in surface coordinates, then surfaces clip to the screen', () => {
  const c = new SurfaceCompositor(3, 2);
  surface(c, 'app', rect(-1, 0, 3, 2), [1, 2, 3, 4, 5, 6]);
  const source = Uint8Array.from([99, 10, 20, 99, 30, 40, 99]);
  c.submitSurfaceFrame('app', source.subarray(1, 5), rect(1, 1, 2, 2));
  source.fill(0);
  assert.deepEqual([...c.composite()], [2, 3, 0, 10, 20, 0]);
  c.submitSurfaceFrame('app', Uint8Array.from([50, 60, 70, 80]), rect(-1, -1, 2, 2));
  // The clipped update changed the offscreen column, leaving visible pixels intact.
  assert.deepEqual([...c.composite()], [2, 3, 0, 10, 20, 0]);
});
test('moving a surface retains its frame; resizing clears it; blanking is reversible', () => {
  const c = new SurfaceCompositor(3, 1);
  surface(c, 'app', rect(0, 0, 2, 1), [7, 9]);
  c.configureSurface('app', { ...rect(1, 0, 2, 1), zOrder: 0, transparency: 'opaque' });
  assert.deepEqual([...c.composite()], [0, 7, 9]);
  c.setScreenBlanked(true); assert.deepEqual([...c.composite()], [0, 0, 0]);
  c.setScreenBlanked(false); assert.deepEqual([...c.composite()], [0, 7, 9]);
  c.configureSurface('app', { ...rect(0, 0, 3, 1), zOrder: 0, transparency: 'opaque' });
  assert.deepEqual([...c.composite()], [0, 0, 0]);
});
test('layer order is independent of creation order; removal reveals lower surfaces', () => {
  const c = new SurfaceCompositor(1, 1);
  surface(c, 'top', rect(0, 0, 1, 1), [20], 10);
  surface(c, 'bottom', rect(0, 0, 1, 1), [80], -1);
  assert.equal(c.composite()[0], 20);
  c.removeSurface('top'); assert.equal(c.composite()[0], 80);
  assert.throws(() => c.submitSurfaceFrame('missing', new Uint8Array(1), rect(0, 0, 1, 1)));
  assert.throws(() => c.submitSurfaceFrame('bottom', new Uint8Array(2), rect(0, 0, 1, 1)));
});
