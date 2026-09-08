const assert = require('node:assert/strict');
const { inflateSync } = require('node:zlib');

// Independent firmware-format decoder for reconstruction tests (not app code).
function applyDisplayPayload(base, payload, width = 640, height = 480) {
  const mode = payload[0]; assert.ok(mode === 3 || mode === 6);
  const [left, top, w, h] = mode === 3
    ? [payload[1] * 4, payload[2] * 2, payload[3] * 4, payload[4] * 2] : [0, 0, width, height];
  assert.ok(w > 0 && h > 0 && left + w <= width && top + h <= height);
  const tokens = inflateSync(payload.subarray(mode === 3 ? 7 : 1));
  const pixels = [];
  for (let i = 0; i < tokens.length;) {
    const token = tokens[i++], color = token & 15;
    let count = token >>> 4;
    if (!count) { count = tokens[i++]; if (!count) { count = tokens[i] | (tokens[i + 1] << 8); i += 2; } }
    assert.ok(count > 0 && pixels.length + count <= w * h);
    for (let n = 0; n < count; n++) pixels.push(color);
  }
  assert.equal(pixels.length, w * h);
  const out = base.slice();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x += 2)
    out[(top + y) * (width / 2) + (left + x) / 2] = (pixels[y * w + x] << 4) | pixels[y * w + x + 1];
  return out;
}
module.exports = { applyDisplayPayload };
